// Home AI picks (0.11.14, W5 Homes) — the Home-facing adapter over the
// EXISTING AI ranking pipeline (ai/ranking.ts `aiRanker.rankShortlist`).
// This is not a second pipeline: it builds a relevance-ranked,
// kind-scoped shortlist from the existing collection selectors, hands
// it to the existing ranker (which validates every returned id against
// the shortlist), and returns only ids the ranker proved are in the
// catalogue. Ranking — not generation — is what guarantees
// locally-playable suggestions (brief §18).
//
// Invocation rule (brief §16): a paid request leaves ONLY from an
// explicit user action (Generate / Request fresh AI picks, or a
// Discover entry-point tap), or from the optional auto-refresh
// preference (default OFF, at most one refresh per kind per 24h,
// deduped in flight). Reading the cache, building a Home model,
// focusing, scrolling and loading a page never call the model.
// Taste is sent only when the existing share-taste preference
// allows it — the ranker gates it too; this module passes an empty
// summary when sharing is off, so taste-derived constraints are
// never smuggled past the gate.
//
// SHIM-0114 — W4 owns the durable cache (§17) and the Home-facing
// trigger/preference APIs (§16). Until W4's contract lands, the
// three functions marked SHIM-0114 below stand in for it: the
// versioned localStorage cache, the auto-refresh preference flag,
// and the request entry point that W4 will replace. Every shim is
// listed in the W5 handoff report. The ranker call itself is real,
// not a shim: swapping the shims for W4's APIs changes storage and
// triggers, not the ranking path.

import { aiRanker, RANKING_PIPELINE_VERSION, type RerankRequest, type RerankResult, type DiscoverCandidate as RankerCandidate, type TasteSummary as RankerTasteSummary } from "@/scripts/lib/ai/ranking.ts";
import { getAiEnabled, getAiEndpoint, getAiModel } from "@/scripts/lib/app-settings.js";
import { getAiShareTaste } from "@/scripts/lib/ai/status.ts";
import { genreLabelForId, type GenreId } from "@/scripts/lib/genres.ts";
import type { CatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  selectHiddenGems,
  selectSeriesWorthStarting,
  selectWorthWatching,
} from "@/scripts/lib/collection-selectors.ts";
import { parseYear } from "@/scripts/lib/browse-filters.ts";
import { summarizeTaste, type TasteModel } from "@/scripts/lib/taste.ts";

export type HomeAiKind = "movie" | "series";

/** One verified AI pick, in model order. `id` is a catalogue primary id. */
export interface HomeAiPick {
  id: string;
  rank: number;
  /** Model reason, sanitised by the ranker; may be the generic ranker reason. */
  reason: string | null;
}

/** What actually produced the picks on screen — the label source. */
export type HomeAiSource = "ai" | "cached-ai" | "local" | "unavailable" | "not-configured";

export interface HomeAiPicksResult {
  picks: HomeAiPick[];
  source: HomeAiSource;
  /** Model id, only when a real request ran or a cached answer carries one. */
  model?: string;
  /** Honest one-line note for the shelf (why local / why unavailable). "" when AI. */
  note: string;
  /** True when a request actually left the device for this result. */
  requestSent: boolean;
}

/** Bump when the Home shortlist, prompt query or validation changes. */
export const HOME_AI_PIPELINE_VERSION = 1;

/** Cache lifetime for Home AI picks (brief §16: ~24h). */
export const HOME_AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Shortlist ceiling handed to the ranker (its own 20-candidate cap). */
export const HOME_AI_SHORTLIST_MAX = 20;

/**
 * The Home query. Deliberately stopword-only ("something", "watch",
 * "tonight" are all ranker stopwords): the Home shortlist is already
 * relevance-ranked by the local selectors, and a content-bearing
 * query would make the ranker's relatedness validation drop picks
 * whose metadata happens not to contain the query words. Medium is
 * enforced by the kind constraint, never by query wording.
 */
export const HOME_AI_QUERY = "Something to watch tonight";

// ---------------------------------------------------------------------------
// Shortlist: relevance-ranked catalogue candidates for the ranker
// ---------------------------------------------------------------------------

export interface HomeAiShortlistOptions {
  /** Ids to exclude outright (completed / started / already featured). */
  excludeIds?: Iterable<string | number>;
  /** Rotation seed — changes which near-best titles fill the pool. */
  rotationSeed?: number;
  /** Candidate pool size before the ranker cap (over-fetch for diversity). */
  poolLimit?: number;
}

function candidateFromGroup(
  index: CatalogIndex,
  primaryId: string,
  kind: HomeAiKind,
): RankerCandidate | null {
  const row = index.byId.get(primaryId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const groupId = index.groupIdByEntryId.get(primaryId);
  const aggregate = groupId ? index.groupAggregates.get(groupId) : undefined;
  const genreKind = kind === "movie" ? "vod" : "series";
  const genres = (aggregate?.genreIds ?? []).map((id) =>
    genreLabelForId(id as GenreId, genreKind as "vod" | "series"),
  );
  const durationRaw = row.duration;
  const runtimeMinutes =
    typeof durationRaw === "string" && durationRaw.trim() !== "" && Number.isFinite(Number(durationRaw))
      ? Math.max(1, Math.round(Number(durationRaw) / 60))
      : undefined;
  return {
    id: primaryId,
    kind,
    title: String(row.name ?? ""),
    year: aggregate?.year ?? parseYear(row.year) ?? undefined,
    rating: aggregate?.rating?.score10,
    voteCount: aggregate?.rating?.voteCount ?? undefined,
    tmdbId: typeof row.tmdb === "number" ? row.tmdb : undefined,
    genres,
    cast: [],
    runtimeMinutes,
    overview: typeof row.plot === "string" && row.plot.trim() ? row.plot.trim() : undefined,
    posterUrl: typeof row.logo === "string" && row.logo ? row.logo : undefined,
    source: "catalog",
  };
}

/**
 * Build the ranker's shortlist: the local selectors' best diverse
 * pool (Worth Watching / Worth Starting, topped up with Hidden
 * Gems), in selector order, capped at the ranker ceiling. Never raw
 * catalogue order — the ranker keeps the head of THIS order.
 * Exclusions (not-interested, dislikes) are applied inside the
 * selectors; `excludeIds` adds caller exclusions (completed,
 * started, featured). Pure — no model call.
 */
export function buildHomeAiShortlist(
  index: CatalogIndex,
  taste: TasteModel | null | undefined,
  kind: HomeAiKind,
  opts: HomeAiShortlistOptions = {},
): RankerCandidate[] {
  const poolLimit = Math.max(HOME_AI_SHORTLIST_MAX, opts.poolLimit ?? HOME_AI_SHORTLIST_MAX * 2);
  const exclude = new Set([...(opts.excludeIds ?? [])].map(String));
  const selectorOpts = {
    rotationSeed: opts.rotationSeed ?? 0,
    excludeCompleted: true,
    completedIds: [...exclude],
    cacheKey: `home-ai|${kind}|${opts.rotationSeed ?? 0}|${[...exclude].sort().join(",")}`,
  };
  const ranked =
    kind === "movie"
      ? selectWorthWatching(index, taste, poolLimit, selectorOpts)
      : selectSeriesWorthStarting(index, taste, poolLimit, {
          ...selectorOpts,
          watchedIds: [...exclude],
        });
  const gemIds = selectHiddenGems(index, taste, Math.ceil(poolLimit / 2), selectorOpts).map(
    (result) => result.id,
  );
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Interleave: two relevance picks, one gem — the model sees quality
  // AND underexposure, not a single ranked list twice.
  let gemAt = 0;
  ranked.forEach((result, position) => {
    if (!seen.has(result.id) && !exclude.has(result.id)) {
      seen.add(result.id);
      ordered.push(result.id);
    }
    if (position % 2 === 1 && gemAt < gemIds.length) {
      const gemId = gemIds[gemAt++];
      if (!seen.has(gemId) && !exclude.has(gemId)) {
        seen.add(gemId);
        ordered.push(gemId);
      }
    }
  });
  for (; gemAt < gemIds.length && ordered.length < poolLimit; gemAt++) {
    const gemId = gemIds[gemAt];
    if (!seen.has(gemId) && !exclude.has(gemId)) {
      seen.add(gemId);
      ordered.push(gemId);
    }
  }
  const candidates: RankerCandidate[] = [];
  for (const id of ordered.slice(0, HOME_AI_SHORTLIST_MAX)) {
    const candidate = candidateFromGroup(index, id, kind);
    if (candidate && candidate.title) candidates.push(candidate);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Reasons: grounded, never generic (brief §13, §22)
// ---------------------------------------------------------------------------

const GENERIC_REASONS = new Set(
  [
    "ranked by ai for this search.",
    "because you might like it",
    "because you might like it.",
    "a great choice for tonight",
    "a great choice for tonight.",
    "ai is unavailable — showing local order.",
  ].map((text) => text.toLowerCase()),
);

/** True when a model reason says nothing grounded — it must be replaced, not shown. */
export function isGenericReason(reason: string | null | undefined): boolean {
  if (!reason) return true;
  return GENERIC_REASONS.has(reason.trim().toLowerCase());
}

export interface GroundedReasonInput {
  /** Model reason (ranker-sanitised) — kept when it says something real. */
  modelReason: string | null | undefined;
  /** Selector reasons for the same title (evidence strings). */
  selectorReasons?: string[];
  /** Genre labels for the title. */
  genres?: string[];
  /** Credible rating label, e.g. "★ 8.4", or "" when unsupported. */
  ratingLabel?: string;
  /** Release year, or "" when unknown. */
  year?: string;
}

/**
 * The reason shown on an AI card. The model's own grounded reason
 * wins; selector evidence (a real rating, a real taste match) is
 * next; a metadata sentence (genre + rating) follows; only when
 * nothing stronger exists does the honest neutral label appear —
 * never a generic "you might like it".
 */
export function groundedReasonForAiCard(input: GroundedReasonInput): string {
  if (input.modelReason && !isGenericReason(input.modelReason)) {
    return input.modelReason.trim();
  }
  const selectorReason = (input.selectorReasons ?? []).find((reason) => reason && !isGenericReason(reason));
  if (selectorReason) return selectorReason.trim();
  const genre = (input.genres ?? [])[0];
  if (genre && input.ratingLabel) {
    return `${genre} · rated ${input.ratingLabel.replace(/^★\s*/, "")}`;
  }
  if (genre) return genre;
  if (input.ratingLabel) return `Rated ${input.ratingLabel.replace(/^★\s*/, "")}`;
  return "AI pick from your library";
}

/** Honest shelf note for a source — the ONLY source labels Homes may use. */
export function homeAiSourceNote(source: HomeAiSource, model?: string): string {
  switch (source) {
    case "ai":
      return model ? `Ranked by AI · ${model}` : "Ranked by AI";
    case "cached-ai":
      return "AI picks from an earlier request — no new request sent";
    case "local":
      return "Local picks — AI wasn't asked";
    case "unavailable":
      return "AI unavailable — showing local picks";
    case "not-configured":
      return "AI isn't set up — showing local picks";
  }
}

// ---------------------------------------------------------------------------
// SHIM-0114 — durable cache (W4 §17 owns this; replaced when W4 lands)
// ---------------------------------------------------------------------------

const HOME_AI_CACHE_KEY = "rs-home-ai-picks-v1";
const HOME_AI_CACHE_MAX_ENTRIES = 6;

interface HomeAiCacheEntry {
  key: string;
  picks: HomeAiPick[];
  model: string;
  answeredAt: number;
  kind: HomeAiKind;
}

interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const memoryStore = new Map<string, string>();
const memoryStorage: KeyValueStore = {
  get: (key) => memoryStore.get(key) ?? null,
  set: (key, value) => {
    memoryStore.set(key, value);
  },
  remove: (key) => {
    memoryStore.delete(key);
  },
};

function defaultStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") {
      return {
        get: (key) => localStorage.getItem(key),
        set: (key, value) => localStorage.setItem(key, value),
        remove: (key) => localStorage.removeItem(key),
      };
    }
  } catch {
    // Storage unavailable — the memory fallback still caches in-session.
  }
  return memoryStorage;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface HomeAiCacheIdentity {
  profileId: string;
  playlistId: string;
  kind: HomeAiKind;
  /** Catalogue fingerprint: index revision + sorted primary ids hash. */
  catalogueFingerprint: string;
  /** Taste revision when sharing is on, "private" when off. */
  tasteRevision: string;
  requestType: "home-picks" | string;
}

/** SHIM-0114: cache identity per §17 (profile, playlist, kind, provider/model, pipeline, taste, request type). */
export function homeAiCacheKey(identity: HomeAiCacheIdentity): string {
  let endpoint = "";
  let model = "";
  try {
    endpoint = String(getAiEndpoint() ?? "").trim();
  } catch {
    endpoint = "";
  }
  try {
    model = String(getAiModel() ?? "").trim();
  } catch {
    model = "";
  }
  return JSON.stringify({
    v: HOME_AI_PIPELINE_VERSION,
    ranker: RANKING_PIPELINE_VERSION,
    profile: identity.profileId,
    playlist: identity.playlistId,
    kind: identity.kind,
    catalogue: identity.catalogueFingerprint,
    taste: identity.tasteRevision,
    request: identity.requestType,
    endpoint,
    model,
  });
}

/** Catalogue fingerprint: revision + hash of the sorted primary ids. */
export function catalogueFingerprintFor(index: CatalogIndex): string {
  const ids = index.groups.map((group) => group.primaryId).sort();
  return `${index.revision}|${index.totalGroups}|${hashString(ids.join(","))}`;
}

/** Taste revision for the cache key: a hash of the shared summary, or "private". */
export function tasteRevisionFor(taste: TasteModel | null | undefined, shareTaste: boolean): string {
  if (!shareTaste || !taste) return "private";
  return hashString(JSON.stringify(summarizeTaste(taste)));
}

function readCacheEntries(store: KeyValueStore): HomeAiCacheEntry[] {
  try {
    const raw = store.get(HOME_AI_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is HomeAiCacheEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as HomeAiCacheEntry).key === "string" &&
        Array.isArray((entry as HomeAiCacheEntry).picks) &&
        typeof (entry as HomeAiCacheEntry).answeredAt === "number",
    );
  } catch {
    return [];
  }
}

function writeCacheEntries(store: KeyValueStore, entries: HomeAiCacheEntry[]): void {
  try {
    store.set(HOME_AI_CACHE_KEY, JSON.stringify(entries.slice(0, HOME_AI_CACHE_MAX_ENTRIES)));
  } catch {
    // A full/unavailable store must never break Home rendering.
  }
}

/** SHIM-0114: read a fresh cached entry, or null. Sync — Home paints cached picks with zero requests. */
export function readCachedHomeAiPicks(
  identity: HomeAiCacheIdentity,
  opts: { nowMs?: number; store?: KeyValueStore } = {},
): { picks: HomeAiPick[]; model: string; answeredAt: number } | null {
  const nowMs = opts.nowMs ?? Date.now();
  const key = homeAiCacheKey(identity);
  const entry = readCacheEntries(opts.store ?? defaultStore()).find((candidate) => candidate.key === key);
  if (!entry) return null;
  if (nowMs - entry.answeredAt > HOME_AI_CACHE_TTL_MS) return null;
  if (entry.picks.length === 0) return null;
  return { picks: [...entry.picks], model: entry.model, answeredAt: entry.answeredAt };
}

/** SHIM-0114: store picks durably (bounded, versioned, no secrets). */
export function writeCachedHomeAiPicks(
  identity: HomeAiCacheIdentity,
  picks: HomeAiPick[],
  model: string,
  opts: { nowMs?: number; store?: KeyValueStore } = {},
): void {
  if (picks.length === 0) return;
  const store = opts.store ?? defaultStore();
  const key = homeAiCacheKey(identity);
  const entries = readCacheEntries(store).filter((entry) => entry.key !== key);
  entries.unshift({
    key,
    picks: picks.map((pick) => ({ id: pick.id, rank: pick.rank, reason: pick.reason })),
    model,
    answeredAt: opts.nowMs ?? Date.now(),
    kind: identity.kind,
  });
  writeCacheEntries(store, entries);
}

/** SHIM-0114: clear the Home AI cache (tests / W4 migration). */
export function clearHomeAiCache(store?: KeyValueStore): void {
  (store ?? defaultStore()).remove(HOME_AI_CACHE_KEY);
  memoryStore.delete(HOME_AI_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// SHIM-0114 — auto-refresh preference (W4 §16 owns the Settings control)
// ---------------------------------------------------------------------------

const HOME_AI_AUTO_REFRESH_KEY = "xt_ai_home_auto_refresh";

/** SHIM-0114: optional Home auto-refresh preference. Default OFF. W4 owns the Settings control for this flag. */
export function getHomeAiAutoRefresh(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(HOME_AI_AUTO_REFRESH_KEY) === "1";
  } catch {
    return false;
  }
}

/** SHIM-0114: see getHomeAiAutoRefresh. */
export function setHomeAiAutoRefresh(auto: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(HOME_AI_AUTO_REFRESH_KEY, auto ? "1" : "0");
  } catch {
    // Preference simply doesn't persist.
  }
}

// ---------------------------------------------------------------------------
// Trigger + request (SHIM-0114 entry point — W4 replaces the trigger
// surface; the ranker call inside is the real existing pipeline)
// ---------------------------------------------------------------------------

export interface RequestHomeAiPicksInput {
  index: CatalogIndex;
  taste: TasteModel | null | undefined;
  kind: HomeAiKind;
  profileId: string;
  playlistId: string;
  /** Ids to exclude (completed / started / featured). */
  excludeIds?: Iterable<string | number>;
  rotationSeed?: number;
  /** Pre-built shortlist (Discover entry-point flow) — skips selector shortlisting. */
  shortlist?: RankerCandidate[];
  /** Query for the ranker (entry-point prompts); defaults to HOME_AI_QUERY. */
  query?: string;
  /** Extra hard constraints (entry-point intent); kind is always enforced. */
  constraints?: { genres?: string[]; maxRuntimeMinutes?: number; mood?: string };
  /** Request-type dimension for the cache key. */
  requestType?: string;
  /**
   * Skip the fresh-cache shortcut and send a new request (explicit
   * "Request fresh AI picks"). The result still overwrites the cache.
   * Default false: an explicit Generate with a fresh cache answers
   * from cache with zero requests.
   */
  force?: boolean;
}

export interface RequestHomeAiPicksDeps {
  rankShortlist?: (request: RerankRequest) => Promise<RerankResult>;
  shareTaste?: boolean;
  aiEnabled?: boolean;
  nowMs?: number;
  store?: KeyValueStore;
}

const inFlight = new Map<string, Promise<HomeAiPicksResult>>();

function aiConfigured(deps: RequestHomeAiPicksDeps): boolean {
  if (deps.aiEnabled !== undefined) return deps.aiEnabled;
  try {
    return getAiEnabled() && !!getAiEndpoint().trim() && !!getAiModel().trim();
  } catch {
    return false;
  }
}

function tasteSummaryFor(
  taste: TasteModel | null | undefined,
  shareTaste: boolean,
): RankerTasteSummary {
  if (!shareTaste || !taste) {
    return { favouriteGenres: [], likedTitles: [], dislikedTitles: [] };
  }
  const summary = summarizeTaste(taste);
  return {
    favouriteGenres: summary.favouriteGenres,
    likedTitles: summary.likedTitles,
    dislikedTitles: summary.dislikedTitles,
    preferredRuntimeMax: summary.preferredRuntimeMax,
    pace: summary.pace,
  };
}

/**
 * SHIM-0114 entry point: request fresh AI picks for one Home shelf.
 * Call ONLY from an explicit user action or the auto-refresh path.
 * Returns cached picks with source "cached-ai" (zero requests) when
 * a fresh entry exists; otherwise sends exactly one ranker request,
 * caches verified survivors, and falls back honestly on failure or
 * rejection (source "local"/"unavailable", picks empty — the caller
 * keeps its local shelves). In-flight requests dedupe by cache key.
 */
export async function requestHomeAiPicks(
  input: RequestHomeAiPicksInput,
  deps: RequestHomeAiPicksDeps = {},
): Promise<HomeAiPicksResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const shareTaste = deps.shareTaste ?? (() => {
    try {
      return getAiShareTaste();
    } catch {
      return false;
    }
  })();
  const identity: HomeAiCacheIdentity = {
    profileId: input.profileId,
    playlistId: input.playlistId,
    kind: input.kind,
    catalogueFingerprint: catalogueFingerprintFor(input.index),
    tasteRevision: tasteRevisionFor(input.taste, shareTaste),
    requestType: input.requestType ?? "home-picks",
  };
  const cacheKey = homeAiCacheKey(identity);

  if (!input.force) {
    const cached = readCachedHomeAiPicks(identity, { nowMs, store: deps.store });
    if (cached) {
      return {
        picks: cached.picks,
        source: "cached-ai",
        model: cached.model || undefined,
        note: homeAiSourceNote("cached-ai"),
        requestSent: false,
      };
    }
  }

  if (!aiConfigured(deps)) {
    return {
      picks: [],
      source: "not-configured",
      note: homeAiSourceNote("not-configured"),
      requestSent: false,
    };
  }

  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const run = (async (): Promise<HomeAiPicksResult> => {
    const shortlist =
      input.shortlist ?? buildHomeAiShortlist(input.index, input.taste, input.kind, {
        excludeIds: input.excludeIds,
        rotationSeed: input.rotationSeed,
      });
    if (shortlist.length === 0) {
      return {
        picks: [],
        source: "local",
        note: "No candidates to rank — showing local picks",
        requestSent: false,
      };
    }
    // Taste-derived constraints only when sharing is on — the
    // constraint list is taste data too, and must not bypass the gate.
    const constraints = {
      kind: input.kind,
      ...(shareTaste ? input.constraints ?? {} : {}),
    };
    const rankShortlist = deps.rankShortlist ?? aiRanker.rankShortlist.bind(aiRanker);
    let result: RerankResult;
    try {
      result = await rankShortlist({
        query: input.query ?? HOME_AI_QUERY,
        shortlist,
        tasteSummary: tasteSummaryFor(input.taste, shareTaste),
        constraints,
        context: {
          playlistId: input.playlistId,
          profileId: input.profileId,
          tasteRevision: identity.tasteRevision,
        },
      });
    } catch (error) {
      const kind = (error as { kind?: string })?.kind;
      return {
        picks: [],
        source: "unavailable",
        note:
          kind === "not_configured"
            ? homeAiSourceNote("not-configured")
            : kind === "rate_limited"
              ? "AI is rate-limiting requests — showing local picks"
              : "AI couldn't answer just now — showing local picks",
        requestSent: true,
      };
    }
    // Defence in depth: the ranker validates against the shortlist,
    // but Homes re-validates kind + catalogue membership before any
    // pick can reach a shelf. A pick that fails here never renders.
    const allowed = new Set(shortlist.map((candidate) => `${candidate.kind}:${candidate.id}`));
    const picks: HomeAiPick[] = [];
    const seen = new Set<string>();
    result.rankings.forEach((ranking, position) => {
      const candidate = ranking.candidate;
      if (candidate.kind !== input.kind) return;
      if (!allowed.has(`${candidate.kind}:${candidate.id}`)) return;
      if (!input.index.byId.has(candidate.id)) return;
      if (seen.has(candidate.id)) return;
      seen.add(candidate.id);
      picks.push({ id: candidate.id, rank: position + 1, reason: ranking.reason || null });
    });
    if (picks.length === 0) {
      return {
        picks: [],
        source: result.source === "cached" ? "cached-ai" : "local",
        model: result.status.model || undefined,
        note: "AI ranked nothing in your library that fits — showing local picks",
        requestSent: result.source !== "cached",
      };
    }
    writeCachedHomeAiPicks(identity, picks, result.status.model || "", { nowMs, store: deps.store });
    return {
      picks,
      source: result.source === "cached" ? "cached-ai" : "ai",
      model: result.status.model || undefined,
      note: homeAiSourceNote(result.source === "cached" ? "cached-ai" : "ai", result.status.model || undefined),
      requestSent: result.source !== "cached",
    };
  })();

  inFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * Quiet auto-refresh (brief §16): only when the optional preference
 * is on AND no fresh cache entry exists. Never retries on failure,
 * never steals focus (the caller repaints one shelf in place).
 * Returns null when no refresh was due — the caller keeps cached or
 * local shelves either way.
 */
export async function maybeAutoRefreshHomeAiPicks(
  input: RequestHomeAiPicksInput,
  deps: RequestHomeAiPicksDeps & { autoRefresh?: boolean } = {},
): Promise<HomeAiPicksResult | null> {
  const auto = deps.autoRefresh ?? getHomeAiAutoRefresh();
  if (!auto) return null;
  const shareTaste = deps.shareTaste ?? (() => {
    try {
      return getAiShareTaste();
    } catch {
      return false;
    }
  })();
  const identity: HomeAiCacheIdentity = {
    profileId: input.profileId,
    playlistId: input.playlistId,
    kind: input.kind,
    catalogueFingerprint: catalogueFingerprintFor(input.index),
    tasteRevision: tasteRevisionFor(input.taste, shareTaste),
    requestType: input.requestType ?? "home-picks",
  };
  if (readCachedHomeAiPicks(identity, { nowMs: deps.nowMs ?? Date.now(), store: deps.store })) {
    return null;
  }
  if (!aiConfigured(deps)) return null;
  return requestHomeAiPicks(input, deps);
}
