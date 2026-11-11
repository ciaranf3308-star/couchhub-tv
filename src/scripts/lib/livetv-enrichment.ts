// Live TV programme enrichment (0.11.0, W2 contract — W3 stand-in).
//
// W2 owns this module; this file is a faithful implementation of the
// contract in couchhub-tv-011-contracts.md so the landing (W3) can
// build, test and screenshot-verify against it before W2's branch
// lands. INTEGRATION: prefer W2's version when the two differ —
// the exported surface must stay identical.
//
// Contract:
//   - enrichProgramme({title, channelName?, startMs?, endMs?}):
//     Promise<ProgrammeArtwork>, never throws, placeholder-source on
//     any failure; only enriches when called (visible/soon-visible
//     only); internal cache incl. failed matches (negative cache,
//     24h); max 2 concurrent TMDB requests; title normalisation
//     strips only safe provider noise, never guesses.
//   - getProgrammeArtworkSync(title): cache peek, no network.
//   - prefetchProgrammes(titles[]): best-effort, bounded (max 8 at
//     a time), non-blocking.
//
// Artwork honesty: nothing here invents broadcast times or
// availability — artwork is matched to the EPG title only, and a
// miss returns a placeholder, never a guessed programme. No paid AI
// is involved; the only network is TMDb, only when the user has a
// TMDb key configured (isTmdbActive), and only for titles the UI
// actually shows.
import { getTmdbApiKey, isTmdbActive } from "@/scripts/lib/app-settings.js";
import {
  fetchMovieEnrichment,
  fetchSeriesEnrichment,
} from "@/scripts/lib/tmdb-enrich";
import { tmdbSearchMovie, tmdbSearchTv } from "@/scripts/lib/tmdb";

export type ProgrammeArtworkSource =
  | "tmdb-episode"
  | "tmdb-series"
  | "tmdb-movie"
  | "channel"
  | "placeholder";

export interface ProgrammeArtwork {
  backdropUrl: string | null;
  posterUrl: string | null;
  stillUrl: string | null;
  source: ProgrammeArtworkSource;
  /** 0..1 — 0 for placeholder / negative-cache entries. */
  confidence: number;
  matchedTitle: string | null;
  synopsis: string | null;
  genres: string[];
}

export interface EnrichProgrammeRequest {
  title: string;
  channelName?: string;
  startMs?: number;
  endMs?: number;
}

export const LIVETV_ENRICHMENT_CACHE_KEY = "redsilk:livetv:enrichment:v1";
export const LIVETV_ENRICHMENT_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const LIVETV_ENRICHMENT_POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVETV_ENRICHMENT_MAX_CONCURRENT = 2;
export const LIVETV_ENRICHMENT_PREFETCH_MAX = 8;

export function placeholderArtwork(): ProgrammeArtwork {
  return {
    backdropUrl: null,
    posterUrl: null,
    stillUrl: null,
    source: "placeholder",
    confidence: 0,
    matchedTitle: null,
    synopsis: null,
    genres: [],
  };
}

/**
 * Strip only safe provider noise from an EPG title before matching:
 * bracketed quality tags ([HD], (FHD)), quality tokens (HD/FHD/4K),
 * a leading LIVE marker, season/episode codes (S01E02, 1x02),
 * "Episode N" / "Ep N" suffixes, and a trailing " | ..." provider
 * suffix. The programme name itself is never rewritten, translated
 * or guessed — a title that is only noise normalises to "" and is
 * never enriched.
 */
export function normaliseProgrammeTitle(raw: string): string {
  let title = (raw ?? "").trim();
  // Bracketed tags: [HD], (2024) is NOT stripped (year is signal).
  title = title.replace(/\[[^\]]*\]/g, " ").replace(/\((?:HD|FHD|UHD|4K|SD)\)/gi, " ");
  // Season / episode codes: "Show S01E02", "Show 1x02", "Show — S2 E5".
  title = title.replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, " ");
  title = title.replace(/\b\d{1,2}x\d{1,3}\b/g, " ");
  title = title.replace(/\b(?:Episode|Ep\.?)\s*\d{1,3}\b/gi, " ");
  // Leading LIVE marker and trailing provider suffix.
  title = title.replace(/^(?:LIVE|Live)\s*[:–—-]\s*/i, "");
  title = title.replace(/\s*\|\s*[^|]+$/, "");
  // Standalone quality tokens.
  title = title.replace(/\b(?:FHD|UHD|4K|HD|SD)\b/gi, " ");
  return title.replace(/\s+/g, " ").trim();
}

function cacheKeyFor(title: string): string {
  return normaliseProgrammeTitle(title).toLowerCase();
}

interface CacheEntry {
  art: ProgrammeArtwork;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

function readPersistedCache(): Map<string, CacheEntry> {
  const out = new Map<string, CacheEntry>();
  try {
    const raw = localStorage.getItem(LIVETV_ENRICHMENT_CACHE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [key, entry] of Object.entries(parsed ?? {})) {
      if (entry && typeof entry.expiresAt === "number" && entry.art) {
        out.set(key, entry);
      }
    }
  } catch {
    // Corrupt cache: start empty, never fatal.
  }
  return out;
}

function persistCache(entries: Map<string, CacheEntry>): void {
  try {
    const now = Date.now();
    const pruned: Record<string, CacheEntry> = {};
    for (const [key, entry] of entries) {
      if (entry.expiresAt > now) pruned[key] = entry;
    }
    // Bound the stored blob: keep the freshest 200 entries.
    const keys = Object.keys(pruned).slice(-200);
    const bounded: Record<string, CacheEntry> = {};
    for (const key of keys) bounded[key] = pruned[key];
    localStorage.setItem(LIVETV_ENRICHMENT_CACHE_KEY, JSON.stringify(bounded));
  } catch {
    // Storage unavailable/full: memory cache still serves this session.
  }
}

function readCache(title: string): ProgrammeArtwork | null {
  const key = cacheKeyFor(title);
  if (!key) return null;
  const now = Date.now();
  const mem = memoryCache.get(key);
  if (mem) {
    if (mem.expiresAt > now) return mem.art;
    memoryCache.delete(key);
  }
  const persisted = readPersistedCache().get(key);
  if (persisted && persisted.expiresAt > now) {
    memoryCache.set(key, persisted);
    return persisted.art;
  }
  return null;
}

function writeCache(title: string, art: ProgrammeArtwork): void {
  const key = cacheKeyFor(title);
  if (!key) return;
  const ttl =
    art.source === "placeholder"
      ? LIVETV_ENRICHMENT_NEGATIVE_TTL_MS
      : LIVETV_ENRICHMENT_POSITIVE_TTL_MS;
  const entry: CacheEntry = { art, expiresAt: Date.now() + ttl };
  memoryCache.set(key, entry);
  try {
    const persisted = readPersistedCache();
    persisted.set(key, entry);
    persistCache(persisted);
  } catch {
    // Memory cache still serves this session.
  }
}

// ── Concurrency: max 2 TMDB requests in flight ──────────────────

let inFlight = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < LIVETV_ENRICHMENT_MAX_CONCURRENT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waitQueue.shift();
  if (next) {
    inFlight += 1;
    next();
  }
}

// ── Matching ────────────────────────────────────────────────────

function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.85;
  const aWords = new Set(na.split(" "));
  const bWords = nb.split(" ");
  const shared = bWords.filter((w) => aWords.has(w)).length;
  return shared / Math.max(bWords.length, 1);
}

async function enrichUncached(req: EnrichProgrammeRequest): Promise<ProgrammeArtwork> {
  const clean = normaliseProgrammeTitle(req.title);
  if (!clean) return placeholderArtwork();
  if (typeof window === "undefined" || !isTmdbActive()) {
    return placeholderArtwork();
  }
  const apiKey = getTmdbApiKey();
  if (!apiKey) return placeholderArtwork();

  await acquireSlot();
  try {
    // Series first (most live-TV programmes are series), then movies.
    const tvResults = await tmdbSearchTv(apiKey, clean);
    for (const result of tvResults.slice(0, 3)) {
      const candidate = result.name ?? result.title ?? "";
      if (titleSimilarity(clean, candidate) < 0.6) continue;
      const detail = await fetchSeriesEnrichment(result.id);
      if (!detail) continue;
      return {
        backdropUrl: detail.backdropUrl,
        posterUrl: detail.posterUrl,
        stillUrl: null,
        source: "tmdb-series",
        confidence: titleSimilarity(clean, candidate) >= 0.95 ? 0.95 : 0.75,
        matchedTitle: detail.title || candidate,
        synopsis: detail.overview || null,
        genres: detail.genres ?? [],
      };
    }
    const movieResults = await tmdbSearchMovie(apiKey, clean);
    for (const result of movieResults.slice(0, 3)) {
      const candidate = result.title ?? result.name ?? "";
      if (titleSimilarity(clean, candidate) < 0.6) continue;
      const detail = await fetchMovieEnrichment(result.id);
      if (!detail) continue;
      return {
        backdropUrl: detail.backdropUrl,
        posterUrl: detail.posterUrl,
        stillUrl: null,
        source: "tmdb-movie",
        confidence: titleSimilarity(clean, candidate) >= 0.95 ? 0.95 : 0.75,
        matchedTitle: detail.title || candidate,
        synopsis: detail.overview || null,
        genres: detail.genres ?? [],
      };
    }
    return placeholderArtwork();
  } catch {
    return placeholderArtwork();
  } finally {
    releaseSlot();
  }
}

/**
 * Enrich one programme title. Never throws; any failure (no key,
 * no match, network error) resolves to a placeholder-source
 * artwork, cached negatively for 24h so a miss is not re-fetched
 * on every focus/scroll.
 */
export async function enrichProgramme(
  req: EnrichProgrammeRequest,
): Promise<ProgrammeArtwork> {
  try {
    if (!req || !req.title || !req.title.trim()) return placeholderArtwork();
    const cached = readCache(req.title);
    if (cached) return cached;
    const art = await enrichUncached(req);
    writeCache(req.title, art);
    return art;
  } catch {
    return placeholderArtwork();
  }
}

/** Cache peek only — no network, no fetch, no throw. */
export function getProgrammeArtworkSync(title: string): ProgrammeArtwork | null {
  try {
    if (!title || !title.trim()) return null;
    return readCache(title);
  } catch {
    return null;
  }
}

/**
 * Best-effort prefetch for titles that are visible or soon
 * visible. Bounded to LIVETV_ENRICHMENT_PREFETCH_MAX titles per
 * call, fire-and-forget, never throws.
 */
export function prefetchProgrammes(titles: string[]): void {
  try {
    const unique = [...new Set((titles ?? []).map((t) => (t ?? "").trim()).filter(Boolean))];
    for (const title of unique.slice(0, LIVETV_ENRICHMENT_PREFETCH_MAX)) {
      if (getProgrammeArtworkSync(title)) continue;
      void enrichProgramme({ title });
    }
  } catch {
    // Prefetch is a nicety, never fatal.
  }
}

/** Test seam: clear the in-memory cache (persisted cache untouched). */
export function __clearEnrichmentMemoryCache(): void {
  memoryCache.clear();
}
