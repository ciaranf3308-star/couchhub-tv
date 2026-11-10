// RedSilk Couch — Home assembly (W3).
//
// Consumes the W2 home-rails contract (HomeRailKind / HomeRailItem /
// HomeRail / HomeHero / getCachedHomeRails / loadHomeRails) and renders
// it in HomeView. CONTRACT NOTE — W2's `src/scripts/lib/home-rails.ts`
// had NOT landed when this module was written (no such file on main @
// 5b8ce78, and no home-rails on any remote branch), so this module
// implements the contract's shapes and entry points on top of the
// engines that DO exist (loadDiscoverData, couch-home.ts builders,
// loadTrending, followed provider, preferences). The swap at
// integration is a one-line import change in HomeView: replace the
// `home-assembly` import with `home-rails` — the types and the two
// entry points are name- and shape-compatible with the contract.
//
// Differences from the contract as specified (all additive, all
// documented so W2's file can replace this module without touching
// HomeView):
//   - HomeRailKind gains "picked-for-you" and "favourite-channels":
//     the rails that exist today have no contract kind, and relabelling
//     them as "next-obsession"/"genre" would be dishonest. W2's new
//     kinds (next-obsession, tonight, short, genre) render with no
//     HomeView change — the view keys presentation off the item kind
//     and the new-episodes rail id only.
//   - HomeRailItem gains optional `overview`: the contract has no
//     description field, but the hero needs the catalogue overview and
//     inventing it from `reason` would be wrong.
//   - `backdropUrl` falls back to the poster's URL. DiscoverCandidate
//     carries no backdrop art (no backdropUrl field anywhere in the
//     catalogue pipeline), so there is no true wide art to use; the
//     hero renders the poster full-bleed with the burgundy scrim, and
//     TvImage's fallback covers a failed load — never a broken image.
//   - loadHomeRails takes an optional third argument
//     `{ playlistId, signal }`. The contract's two-argument form still
//     works (playlist-dependent rails are then omitted); the view
//     passes the playlist id so trending / progress / favourite
//     channels can load, exactly as HomeView did before this pass.
//
// Cache rule (the view depends on it): a valid cached payload is
// NEVER replaced by an empty one. loadHomeRails failing, or returning
// no hero and no rails while a cache exists, leaves the cache — and
// the screen — untouched.

import {
  candidateDetailHref,
  candidateKey,
  getDiscoverRows,
  type DiscoverCandidate,
  type DiscoverData,
  type FollowedEpisode,
  type RankedCandidate,
} from "@/scripts/lib/discover.ts";
import {
  buildHomeRails,
  candidateCards,
  favouriteChannelCards,
  hiddenGemCards,
  newEpisodeCards,
  newEpisodeHref,
  pickHero,
  rankedCards,
  seriesProgressCards,
  trendingCards,
  vodProgressCards,
  type FavouriteChannelInput,
  type HeroPick,
  type HomeCard,
  type HomeProgressRow,
} from "@/scripts/lib/couch-home.ts";
import { loadTrending } from "@/scripts/lib/trending.ts";
import { computeNowNext } from "@/scripts/lib/now-next.ts";
import {
  ensureFollowedLoaded,
  followedProvider,
} from "@/scripts/lib/followed.ts";

// --- Contract types (verbatim from the W2 contract, plus the two
// documented additive extensions above) ------------------------------

export type HomeRailKind =
  | "continue-watching"
  | "new-episodes"
  | "next-obsession"
  | "trending"
  | "hidden-gems"
  | "tonight"
  | "recently-added"
  | "continue-series"
  | "short"
  | "genre"
  | "picked-for-you"
  | "favourite-channels";

export interface HomeRailItem {
  key: string;
  kind: "movie" | "series" | "live";
  id: string | number;
  title: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  rating?: number;
  voteCount?: number;
  runtimeMinutes?: number;
  progress?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  detectedAt?: string;
  detailHref: string;
  playHref?: string;
  reason?: string;
  isLive?: boolean;
  nowTitle?: string;
  nextTitle?: string;
  /** Catalogue overview (hero description). Additive vs the contract. */
  overview?: string;
}

export interface HomeRail {
  id: string;
  kind: HomeRailKind;
  title: string;
  description?: string;
  items: HomeRailItem[];
  seeAllHref?: string;
}

export interface HomeHero {
  item: HomeRailItem;
  reason?: string;
}

export interface HomePayload {
  hero: HomeHero | null;
  rails: HomeRail[];
}

export const HOME_CACHE_KEY = "rs_home_rails_v1";

// --- Small pure helpers ------------------------------------------------

/** Rails with no items render nothing — never an empty shell. */
export function dropEmptyRails(rails: HomeRail[]): HomeRail[] {
  return rails.filter((rail) => Array.isArray(rail.items) && rail.items.length > 0);
}

function parseYearRating(meta?: string): { year?: number; rating?: number } {
  if (!meta) return {};
  const out: { year?: number; rating?: number } = {};
  const year = meta.match(/(19|20)\d{2}/);
  if (year) out.year = Number(year[0]);
  const rating = meta.match(/★\s*(\d+(?:\.\d+)?)/);
  if (rating) {
    const value = Number(rating[1]);
    if (Number.isFinite(value)) out.rating = value;
  }
  return out;
}

function candidateFields(
  candidate: DiscoverCandidate | undefined,
  meta?: string,
): Pick<HomeRailItem, "year" | "rating" | "runtimeMinutes" | "overview" | "posterUrl" | "backdropUrl"> {
  if (candidate) {
    return {
      year: candidate.year,
      rating: candidate.rating,
      runtimeMinutes: candidate.runtimeMinutes,
      overview: candidate.overview,
      posterUrl: candidate.posterUrl,
      // No true backdrop art exists in the catalogue pipeline (see
      // header note); the poster is the honest fallback.
      backdropUrl: candidate.posterUrl,
    };
  }
  const parsed = parseYearRating(meta);
  return { ...parsed, posterUrl: undefined, backdropUrl: undefined };
}

function itemKindForKey(key: string): HomeRailItem["kind"] {
  if (key.startsWith("series:") || key.startsWith("followed:")) return "series";
  if (key.startsWith("live:")) return "live";
  return "movie";
}

function idForKey(key: string): string {
  const parts = key.split(":");
  if (parts[0] === "followed") return parts[1] ?? key;
  return parts.slice(1).join(":") || key;
}

/**
 * Map one couch-home HomeCard onto a contract HomeRailItem, enriching
 * it from the candidate index when the catalogue knows the title.
 * `playHref` is set only when the card's own href already autoplays
 * (continue-watching / new-episode cards) — a plain detail link is
 * not silently turned into autoplay.
 */
export function cardToHomeItem(
  card: HomeCard,
  byKey: Map<string, DiscoverCandidate>,
): HomeRailItem {
  const kind = itemKindForKey(card.key);
  const lookupKey =
    kind === "series" && card.key.startsWith("followed:")
      ? `series:${idForKey(card.key)}`
      : card.key;
  const candidate = byKey.get(lookupKey);
  const fields = candidateFields(candidate, card.meta);
  const autoplays = /[?&]autoplay=1/.test(card.href);
  const item: HomeRailItem = {
    key: card.key,
    kind,
    id: idForKey(card.key),
    title: card.title,
    ...fields,
    // The card's own image wins over the candidate lookup: a channel
    // logo or a series poster the candidate map does not carry.
    posterUrl: card.image ?? fields.posterUrl,
    backdropUrl: card.image ?? fields.backdropUrl,
    progress: card.progress,
    detailHref: card.href,
    reason: card.subtitle,
  };
  if (autoplays) item.playHref = card.href;
  if (kind === "live") item.isLive = true;
  return item;
}

/** New-episode item straight from the followed provider (no parsing). */
export function episodeToHomeItem(
  episode: FollowedEpisode,
  byKey: Map<string, DiscoverCandidate>,
): HomeRailItem {
  const candidate = byKey.get(`series:${episode.seriesId}`);
  const fields = candidateFields(candidate);
  return {
    key: `followed:${episode.seriesId}:S${episode.season}E${episode.episode}`,
    kind: "series",
    id: episode.seriesId,
    title: episode.seriesTitle,
    ...fields,
    posterUrl: episode.posterUrl ?? fields.posterUrl,
    backdropUrl: episode.posterUrl ?? fields.backdropUrl,
    season: episode.season,
    episode: episode.episode,
    episodeTitle: episode.episodeTitle,
    detectedAt: episode.detectedAt,
    detailHref: newEpisodeHref(episode),
    playHref: newEpisodeHref(episode),
    reason: `New: S${episode.season} E${episode.episode}${episode.episodeTitle ? ` — ${episode.episodeTitle}` : ""}`,
  };
}

/** Favourite-channel item straight from the guide-enriched input. */
export function channelToHomeItem(channel: FavouriteChannelInput): HomeRailItem {
  return {
    key: `live:${channel.id}`,
    kind: "live",
    id: channel.id,
    title: channel.name,
    posterUrl: channel.logo ?? undefined,
    backdropUrl: channel.logo ?? undefined,
    detailHref: `/livetv?channel=${encodeURIComponent(channel.id)}`,
    playHref: `/livetv?channel=${encodeURIComponent(channel.id)}`,
    reason: channel.nowTitle ?? "Live TV",
    isLive: true,
    nowTitle: channel.nowTitle ?? undefined,
    nextTitle: channel.nextTitle ?? undefined,
  };
}

function railKindForId(id: string): HomeRailKind {
  switch (id) {
    case "continue-watching":
      return "continue-watching";
    case "new-episodes":
      return "new-episodes";
    case "trending":
      return "trending";
    case "recently-added":
      return "recently-added";
    case "continue-series":
      return "continue-series";
    case "hidden-gems":
      return "hidden-gems";
    case "picked-for-you":
      return "picked-for-you";
    case "favourite-channels":
      return "favourite-channels";
    default:
      return "genre";
  }
}

/** Hero pick -> contract hero. `progress` marks a resume (Play becomes Resume). */
export function heroPickToHomeHero(
  pick: HeroPick | null,
  progress?: number,
): HomeHero | null {
  if (!pick) return null;
  const candidate = pick.candidate;
  const detailHref = candidateDetailHref(candidate);
  const playHref =
    candidate.kind === "series"
      ? `/series/detail?id=${encodeURIComponent(candidate.id)}&autoplay=1`
      : candidate.kind === "live"
        ? `/livetv?channel=${encodeURIComponent(candidate.id)}`
        : `/movies/detail?id=${encodeURIComponent(candidate.id)}&autoplay=1`;
  return {
    item: {
      key: candidateKey(candidate),
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      year: candidate.year,
      posterUrl: candidate.posterUrl,
      backdropUrl: candidate.posterUrl,
      rating: candidate.rating,
      runtimeMinutes: candidate.runtimeMinutes,
      overview: candidate.overview,
      progress,
      detailHref,
      playHref,
    },
    reason: pick.eyebrow,
  };
}

// --- Cache (sessionStorage; injectable store so tests need no DOM) ------

export interface HomeCacheStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): HomeCacheStore | null {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    return null;
  }
  return null;
}

function isValidPayload(value: unknown): value is HomePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<HomePayload>;
  if (!Array.isArray(payload.rails)) return false;
  if (payload.hero !== null && payload.hero !== undefined && typeof payload.hero !== "object") {
    return false;
  }
  return payload.rails.every(
    (rail) =>
      rail &&
      typeof rail === "object" &&
      typeof (rail as HomeRail).id === "string" &&
      Array.isArray((rail as HomeRail).items),
  );
}

export function readHomeCache(store: HomeCacheStore | null = defaultStore()): HomePayload | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(HOME_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeHomeCache(
  payload: HomePayload,
  store: HomeCacheStore | null = defaultStore(),
): void {
  if (!store) return;
  if (!payload.hero && payload.rails.length === 0) return; // Never cache empty.
  try {
    store.setItem(HOME_CACHE_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
  } catch {
    // Storage full / unavailable: cache is a nicety, never fatal.
  }
}

/**
 * Never replace valid cached content with an empty screen. A failed
 * or empty fresh load keeps the cache; a fresh load with real content
 * replaces it.
 */
export function mergeHomePayload(
  cached: HomePayload | null,
  fresh: HomePayload | null,
): HomePayload | null {
  if (!fresh) return cached;
  const freshHasContent = !!fresh.hero || fresh.rails.length > 0;
  if (!freshHasContent) return cached;
  return fresh;
}

/** Contract entry point: synchronous cached first paint. */
export function getCachedHomeRails(): HomePayload | null {
  return readHomeCache();
}

// --- Live loading ---------------------------------------------------------

export async function loadFavouriteChannels(
  playlistId: string,
): Promise<FavouriteChannelInput[]> {
  const prefs = await import("@/scripts/lib/preferences.js");
  const liveCatalog = await import("@/scripts/lib/live-catalog.ts");
  try {
    const cache = await import("@/scripts/lib/cache.js");
    await cache.hydrate(playlistId, "live").catch(() => {});
  } catch {
    // Live cache unavailable: favourites still resolve from preferences.
  }
  const favIds = [...(prefs.getFavorites(playlistId, "live") ?? [])] as Array<number | string>;
  if (!favIds.length) return [];
  const channels = liveCatalog.readCachedLiveChannels(playlistId) as Array<{
    id: number | string;
    name?: string;
    logo?: string | null;
  }>;
  const byId = new Map(channels.map((ch) => [Number(ch.id), ch]));
  let programmes: unknown = null;
  try {
    const epg = await import("@/scripts/lib/epg-data.js");
    programmes = epg.getProgrammesSync(playlistId)?.programmes ?? null;
  } catch {
    programmes = null;
  }
  const out: FavouriteChannelInput[] = [];
  for (const id of favIds) {
    const channel = byId.get(Number(id));
    const meta = prefs.getFavoriteMeta(playlistId, "live", Number(id)) as
      | { name?: string; logo?: string | null }
      | null
      | undefined;
    const storedName = meta?.name && !/^Channel \d+$/i.test(meta.name) ? meta.name : "";
    const name = channel?.name || storedName;
    if (!name) continue;
    let nowTitle: string | null = null;
    let nextTitle: string | null = null;
    if (programmes && channel) {
      try {
        const slot = computeNowNext(
          programmes as Parameters<typeof computeNowNext>[0],
          channel as Parameters<typeof computeNowNext>[1],
          playlistId,
        );
        nowTitle = slot?.current?.title ?? null;
        nextTitle = slot?.next?.title ?? null;
      } catch {
        // No guide slot: the card still shows, with "Live TV".
      }
    }
    out.push({
      id: Number(id),
      name,
      logo: meta?.logo ?? channel?.logo ?? null,
      nowTitle,
      nextTitle,
    });
  }
  return out;
}

export interface LoadHomeRailsOptions {
  playlistId?: string;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Home load aborted", "AbortError");
}

/**
 * Contract entry point: build the hero + rails from Discover data and
 * followed episodes. Playlist-dependent rails (trending, progress,
 * favourite channels) need opts.playlistId and are omitted without it.
 * Never throws for a single failed sub-load: a rail whose source
 * failed is omitted, and the remaining rails still render.
 */
export async function loadHomeRails(
  data: DiscoverData,
  followed: FollowedEpisode[],
  opts: LoadHomeRailsOptions = {},
): Promise<HomePayload> {
  const playlistId = opts.playlistId ?? "";
  const signal = opts.signal;
  throwIfAborted(signal);

  const byKey = new Map(data.candidates.map((c) => [candidateKey(c), c]));
  const rows = getDiscoverRows({
    candidates: data.candidates,
    taste: data.taste,
    continueWatching: data.continueWatching,
    recentlyAdded: data.recentlyAdded,
    nowPlaying: data.nowPlaying,
    becauseItems: data.becauseItems,
    watchedKeys: data.watchedKeys,
    excludeWatched: true,
  });
  const pickedRow = rows.find((r) => r.id === "picked-for-you");
  const pickedItems: RankedCandidate[] = pickedRow?.items ?? [];

  let progressRows: HomeProgressRow[] = [];
  let trendingItems: ReturnType<typeof trendingCards> = [];
  let trendingSource: "google" | "tmdb" | "none" = "none";
  let favChannels: FavouriteChannelInput[] = [];

  if (playlistId) {
    const prefs = await import("@/scripts/lib/preferences.js");
    throwIfAborted(signal);
    try {
      progressRows = (prefs.getContinueWatching(playlistId, 12) || []) as HomeProgressRow[];
    } catch {
      progressRows = [];
    }
    try {
      const trendingResult = await loadTrending(playlistId);
      throwIfAborted(signal);
      trendingSource = trendingResult.source;
      trendingItems = trendingCards(trendingResult.items);
    } catch {
      trendingItems = [];
      trendingSource = "none";
    }
    try {
      favChannels = await loadFavouriteChannels(playlistId);
      throwIfAborted(signal);
    } catch {
      favChannels = [];
    }
  }

  const pickedKeys = new Set(pickedItems.map((r) => candidateKey(r.candidate)));
  const gemExcluded = new Set([...pickedKeys, ...data.taste.notInterestedKeys]);

  // Hero resume fraction: the picked hero is mid-way through something
  // exactly when its progress row exists.
  const progressByKey = new Map<string, number>();
  for (const row of progressRows) {
    if (!row.duration || row.duration <= 0) continue;
    const fraction = Math.max(0, Math.min(1, (row.position || 0) / row.duration));
    const key =
      row.kind === "vod"
        ? `movie:${row.id}`
        : row.seriesId != null
          ? `series:${row.seriesId}`
          : null;
    if (key && !progressByKey.has(key)) progressByKey.set(key, fraction);
  }

  const pick = pickHero({
    continueWatching: data.continueWatching,
    picked: pickedItems,
    recentlyAdded: data.recentlyAdded,
  });
  const hero = heroPickToHomeHero(
    pick,
    pick ? progressByKey.get(candidateKey(pick.candidate)) : undefined,
  );

  const couchRails = buildHomeRails({
    continueWatching: vodProgressCards(progressRows, byKey),
    newEpisodes: newEpisodeCards(followed),
    picked: rankedCards(pickedItems),
    trendingSource,
    trending: trendingItems,
    recentlyAdded: candidateCards(data.recentlyAdded.filter((c) => c.kind === "movie")),
    continueSeries: seriesProgressCards(progressRows, byKey),
    favouriteChannels: favouriteChannelCards(favChannels),
    hiddenGems: hiddenGemCards(data.candidates, data.watchedKeys, gemExcluded),
  });

  const rails: HomeRail[] = couchRails.map((rail) => {
    let items: HomeRailItem[];
    if (rail.id === "new-episodes") {
      items = followed
        .filter((ep) => !ep.watched)
        .slice(0, 12)
        .map((ep) => episodeToHomeItem(ep, byKey));
    } else if (rail.id === "favourite-channels") {
      items = favChannels.map((ch) => channelToHomeItem(ch));
    } else {
      items = rail.cards.map((card) => cardToHomeItem(card, byKey));
    }
    return {
      id: rail.id,
      kind: railKindForId(rail.id),
      title: rail.title,
      description: rail.subtitle,
      items,
      seeAllHref: rail.href,
    };
  });

  const payload: HomePayload = { hero, rails: dropEmptyRails(rails) };
  writeHomeCache(payload);
  return payload;
}

/** Convenience for the view: followed episodes via the registered provider. */
export async function loadFollowedEpisodes(): Promise<FollowedEpisode[]> {
  try {
    await ensureFollowedLoaded();
  } catch {
    // Followed store unavailable: new-episodes rail is omitted, the
    // rest of Home still renders.
  }
  try {
    return followedProvider.getNewEpisodes();
  } catch {
    return [];
  }
}
