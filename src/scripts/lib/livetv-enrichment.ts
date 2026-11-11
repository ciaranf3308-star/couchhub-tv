// Live TV programme enrichment (0.11.0 W4 — contract module).
//
// Implements the shared enrichment API from couchhub-tv-011-contracts.md:
// enrichProgramme / getProgrammeArtworkSync / prefetchProgrammes, over the
// existing TMDb infra (tmdb-enrich resolve + fetch, 30-day caches). W2 owns
// the full enrichment work; this is the minimal contract-faithful
// implementation the Channel Browser needs to build and verify against —
// the integration agent keeps whichever of the two implementations is
// fuller. Rules honoured here, per contract:
//   - enrichProgramme never throws; any failure returns placeholder art.
//   - Only called for visible/soon-visible programmes (the browser calls
//     it for the selected channel only); never on load/focus/scroll.
//   - Internal cache including failed matches (negative cache, 24h).
//   - Max 2 concurrent TMDb requests.
//   - Title normalisation strips only safe provider noise
//     (cleanProviderTitle); a match must be an exact normalised title
//     match (pickTmdbMatch), never a guess — so no programme art is ever
//     invented for the wrong show.
//   - No network at all when TMDb is inactive (no key): placeholder,
//     uncached, so enabling a key later takes effect immediately.
import { isTmdbActive } from "./app-settings.js";
import { normalize } from "./text";
import { cleanProviderTitle } from "./tmdb-match";
import {
  fetchMovieEnrichment,
  fetchSeriesEnrichment,
  resolveTmdbId,
} from "./tmdb-enrich";

export interface ProgrammeArtwork {
  backdropUrl: string | null;
  posterUrl: string | null;
  stillUrl: string | null;
  source: "tmdb-episode" | "tmdb-series" | "tmdb-movie" | "channel" | "placeholder";
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

/** Negative-cache TTL: a genuine "no match" is not re-probed for a day. */
export const PROGRAMME_ARTWORK_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** Positive matches are re-checked daily too (artwork can change). */
export const PROGRAMME_ARTWORK_TTL_MS = 24 * 60 * 60 * 1000;
export const PROGRAMME_ENRICH_MAX_CONCURRENT = 2;
export const PROGRAMME_PREFETCH_MAX = 8;

/** Playlist id used for the shared TMDb match cache namespace. */
const LIVETV_PROGRAMME_PLAYLIST_ID = "livetv";

const PLACEHOLDER: ProgrammeArtwork = {
  backdropUrl: null,
  posterUrl: null,
  stillUrl: null,
  source: "placeholder",
  confidence: 0,
  matchedTitle: null,
  synopsis: null,
  genres: [],
};

interface CacheEntry {
  art: ProgrammeArtwork;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test/support hook: drop the in-memory artwork cache. */
export function resetProgrammeArtworkCache(): void {
  cache.clear();
}

function cacheKeyFor(title: string): string {
  const { variants } = cleanProviderTitle(title);
  const cleaned = variants[0] ?? title;
  return normalize(cleaned);
}

// ── Concurrency: at most 2 TMDb resolutions in flight ──
let inFlight = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inFlight < PROGRAMME_ENRICH_MAX_CONCURRENT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inFlight += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function enrichUncached(req: EnrichProgrammeRequest): Promise<ProgrammeArtwork> {
  const title = (req.title ?? "").trim();
  if (!title) return PLACEHOLDER;
  if (!isTmdbActive()) return PLACEHOLDER;
  const key = cacheKeyFor(title);
  if (!key) return PLACEHOLDER;

  // TV first (most live programmes are series), then movie.
  await acquireSlot();
  try {
    for (const kind of ["series", "movie"] as const) {
      const tmdbKind = kind === "series" ? "series" : "vod";
      const tmdbId = await resolveTmdbId(LIVETV_PROGRAMME_PLAYLIST_ID, tmdbKind, {
        id: `programme:${key}`,
        name: title,
      });
      if (tmdbId == null) continue;
      const enrichment =
        kind === "series"
          ? await fetchSeriesEnrichment(tmdbId)
          : await fetchMovieEnrichment(tmdbId);
      if (!enrichment) continue;
      if (!enrichment.backdropUrl && !enrichment.posterUrl) continue;
      return {
        backdropUrl: enrichment.backdropUrl,
        posterUrl: enrichment.posterUrl,
        stillUrl: null,
        source: kind === "series" ? "tmdb-series" : "tmdb-movie",
        // resolveTmdbId only returns exact normalised title matches.
        confidence: 0.9,
        matchedTitle: enrichment.title || null,
        synopsis: enrichment.overview || null,
        genres: enrichment.genres ?? [],
      };
    }
    return PLACEHOLDER;
  } catch {
    return PLACEHOLDER;
  } finally {
    releaseSlot();
  }
}

export async function enrichProgramme(
  req: EnrichProgrammeRequest,
): Promise<ProgrammeArtwork> {
  try {
    const title = (req.title ?? "").trim();
    if (!title) return PLACEHOLDER;
    const key = cacheKeyFor(title);
    if (!key) return PLACEHOLDER;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.art;
    if (hit) cache.delete(key);
    const art = await enrichUncached(req);
    // Never cache the "TMDb inactive" placeholder: enabling a key
    // later must take effect without waiting out a TTL.
    if (!(art.source === "placeholder" && !isTmdbActive())) {
      cache.set(key, { art, expiresAt: Date.now() + PROGRAMME_ARTWORK_TTL_MS });
    }
    return art;
  } catch {
    return PLACEHOLDER;
  }
}

/** Cache peek only — no network, no throw. */
export function getProgrammeArtworkSync(title: string): ProgrammeArtwork | null {
  try {
    const key = cacheKeyFor(title ?? "");
    if (!key) return null;
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return hit.art;
  } catch {
    return null;
  }
}

/** Best-effort, bounded, non-blocking prefetch of visible titles. */
export function prefetchProgrammes(titles: string[]): void {
  try {
    const unique = [...new Set((titles ?? []).map((t) => (t ?? "").trim()).filter(Boolean))];
    for (const title of unique.slice(0, PROGRAMME_PREFETCH_MAX)) {
      void enrichProgramme({ title }).catch(() => undefined);
    }
  } catch {
    // Prefetch never throws.
  }
}
