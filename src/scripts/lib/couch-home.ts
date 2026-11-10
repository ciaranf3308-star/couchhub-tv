// RedSilk Couch — Home rail assembly (W2).
//
// Pure functions over data the existing services already load
// (loadDiscoverData / loadTrending / followed provider / preferences).
// No browser globals, no network, no invented content: every card maps
// to a real catalogue title, a real followed episode, or a real live
// channel, and a rail is omitted entirely when it has nothing real to
// show. The Svelte view (HomeView) owns loading; this module owns the
// ordering and filtering rules so vitest can prove them:
//
//   Rail order (fixed): Continue Watching, New Episodes, Picked for
//   You, Trending, Recently Added Movies, Continue Your Series,
//   Favourite Live Channels, Hidden Gems.
//
//   Continue Watching is Movies & Series ONLY. Live-channel recents
//   are a different thing (tuning back in, not resuming) and must never
//   appear in this row — filterVodProgress drops kind "live" even if a
//   caller passes it in.

import {
  candidateDetailHref,
  candidateKey,
  type DiscoverCandidate,
  type FollowedEpisode,
  type RankedCandidate,
} from "@/scripts/lib/discover.ts";
import {
  trendingSourceLabel,
  type TrendingRailItem,
  type TrendingSource,
} from "@/scripts/lib/trending.ts";
import { railCardHref } from "@/scripts/lib/rail-card.ts";

export type HomeCardKind = "poster" | "landscape" | "channel";

export interface HomeCard {
  key: string;
  title: string;
  subtitle?: string;
  meta?: string;
  image?: string;
  kind: HomeCardKind;
  /** Watched fraction 0..1 (Continue Watching / Continue Your Series). */
  progress?: number;
  badge?: string;
  href: string;
}

export interface HomeRail {
  id: string;
  title: string;
  subtitle?: string;
  href?: string;
  cards: HomeCard[];
}

/** One progress row from preferences.getContinueWatching(). */
export interface HomeProgressRow {
  kind: "vod" | "episode" | "live";
  id: string | number;
  position?: number;
  duration?: number;
  completed?: boolean;
  updatedAt?: number;
  seriesId?: string | number | null;
  seriesName?: string | null;
  season?: number | null;
  episodeNum?: number | null;
  episodeTitle?: string | null;
  seriesLogo?: string | null;
  name?: string | null;
  logo?: string | null;
}

export const HOME_RAIL_ORDER = [
  "continue-watching",
  "new-episodes",
  "picked-for-you",
  "trending",
  "recently-added",
  "continue-series",
  "favourite-channels",
  "hidden-gems",
] as const;

export const HIDDEN_GEM_MIN_RATING = 7.5;
export const HOME_RAIL_LIMIT = 12;

/** "2024 · ★ 8.4" — only from data the catalogue actually carries. */
export function candidateMeta(candidate: DiscoverCandidate): string | undefined {
  const parts: string[] = [];
  if (candidate.year) parts.push(String(candidate.year));
  if (typeof candidate.rating === "number" && Number.isFinite(candidate.rating)) {
    parts.push(`★ ${candidate.rating.toFixed(1)}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function progressFraction(row: HomeProgressRow): number {
  if (!row.duration || row.duration <= 0) return 0;
  return Math.max(0, Math.min(1, (row.position || 0) / row.duration));
}

function episodeLabel(row: HomeProgressRow): string {
  const season = row.season != null ? `S${row.season}` : "";
  const episode = row.episodeNum != null ? `E${row.episodeNum}` : "";
  return season + episode || "Episode";
}

/**
 * Continue Watching rows, Movies & Series ONLY. Live-channel history
 * is dropped here by rule — resuming a film/episode is not the same
 * as tuning back to a channel, and the old strip's seven-channel
 * pile-up is exactly what this fixes. Also drops completed rows and
 * rows with no real progress, mirroring getContinueWatching's own
 * gating so a stale caller cannot leak them back in.
 */
export function filterVodProgress(rows: HomeProgressRow[]): HomeProgressRow[] {
  return rows.filter(
    (row) =>
      (row.kind === "vod" || row.kind === "episode") &&
      !row.completed &&
      (row.position ?? 0) > 0,
  );
}

export function vodProgressCards(
  rows: HomeProgressRow[],
  candidatesByKey: Map<string, DiscoverCandidate>,
): HomeCard[] {
  const cards: HomeCard[] = [];
  for (const row of filterVodProgress(rows)) {
    if (row.kind === "vod") {
      const candidate = candidatesByKey.get(`movie:${row.id}`);
      if (!candidate) continue;
      cards.push({
        key: candidateKey(candidate),
        title: candidate.title,
        subtitle: "Film",
        meta: candidateMeta(candidate),
        image: candidate.posterUrl,
        kind: "poster",
        progress: progressFraction(row),
        href: `/movies/detail?id=${encodeURIComponent(row.id)}&autoplay=1`,
      });
      continue;
    }
    // Episode: the card is the series (that's what's playable), the
    // subtitle names the episode being resumed.
    if (row.seriesId == null) continue;
    const candidate = candidatesByKey.get(`series:${row.seriesId}`);
    if (!candidate) continue;
    cards.push({
      key: `series:${row.seriesId}`,
      title: candidate.title,
      subtitle: row.episodeTitle
        ? `${episodeLabel(row)} — ${row.episodeTitle}`
        : episodeLabel(row),
      meta: candidateMeta(candidate),
      image: candidate.posterUrl,
      kind: "poster",
      progress: progressFraction(row),
      href: `/series/detail?id=${encodeURIComponent(row.seriesId)}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
    });
  }
  return cards.slice(0, HOME_RAIL_LIMIT);
}

/** "Continue Your Series": episode-progress rows only, landscape cards. */
export function seriesProgressCards(
  rows: HomeProgressRow[],
  candidatesByKey: Map<string, DiscoverCandidate>,
): HomeCard[] {
  const cards: HomeCard[] = [];
  const seen = new Set<string>();
  for (const row of filterVodProgress(rows)) {
    if (row.kind !== "episode" || row.seriesId == null) continue;
    const key = `series:${row.seriesId}`;
    if (seen.has(key)) continue;
    const candidate = candidatesByKey.get(key);
    if (!candidate) continue;
    seen.add(key);
    cards.push({
      key,
      title: candidate.title,
      subtitle: row.episodeTitle
        ? `${episodeLabel(row)} — ${row.episodeTitle}`
        : episodeLabel(row),
      meta: candidateMeta(candidate),
      image: candidate.posterUrl,
      kind: "landscape",
      progress: progressFraction(row),
      href: `/series/detail?id=${encodeURIComponent(row.seriesId)}&autoplay=1&episode=${encodeURIComponent(row.id)}`,
    });
  }
  return cards.slice(0, HOME_RAIL_LIMIT);
}

export function rankedCards(items: RankedCandidate[]): HomeCard[] {
  return items.slice(0, HOME_RAIL_LIMIT).map((item) => ({
    key: candidateKey(item.candidate),
    title: item.candidate.title,
    subtitle: item.reason || undefined,
    meta: candidateMeta(item.candidate),
    image: item.candidate.posterUrl,
    kind: "poster" as const,
    href: candidateDetailHref(item.candidate),
  }));
}

export function candidateCards(candidates: DiscoverCandidate[]): HomeCard[] {
  return candidates.slice(0, HOME_RAIL_LIMIT).map((candidate) => ({
    key: candidateKey(candidate),
    title: candidate.title,
    subtitle: candidate.kind === "series" ? "Series" : candidate.kind === "live" ? "Live TV" : "Film",
    meta: candidateMeta(candidate),
    image: candidate.posterUrl,
    kind: "poster" as const,
    href: candidateDetailHref(candidate),
  }));
}

/**
 * Detail URL for a followed episode. Matches
 * followed.buildSeriesDetailUrl exactly (id + season + epnum +
 * autoplay) — an episode always autoplays, which is Watch Now
 * semantics. Kept as a pure builder here so the home rail and the
 * Followed page agree without the pure module importing the
 * followed store.
 */
export function newEpisodeHref(episode: FollowedEpisode): string {
  const params = new URLSearchParams({ id: episode.seriesId });
  params.set("season", String(episode.season));
  params.set("epnum", String(episode.episode));
  params.set("autoplay", "1");
  return `/series/detail?${params.toString()}`;
}

/** New Episodes from Followed Series — unwatched only, newest first. */
export function newEpisodeCards(episodes: FollowedEpisode[]): HomeCard[] {
  return episodes
    .filter((ep) => !ep.watched)
    .slice(0, HOME_RAIL_LIMIT)
    .map((ep) => ({
      key: `followed:${ep.seriesId}:S${ep.season}E${ep.episode}`,
      title: ep.seriesTitle,
      subtitle: `New: S${ep.season} E${ep.episode}${ep.episodeTitle ? ` — ${ep.episodeTitle}` : ""}`,
      meta: undefined,
      image: ep.posterUrl,
      kind: "landscape" as const,
      href: newEpisodeHref(ep),
    }));
}

/** Trending, matched to the library by loadTrending — never invented. */
export function trendingCards(items: TrendingRailItem[]): HomeCard[] {
  return items.slice(0, HOME_RAIL_LIMIT).map((item) => ({
    key: `${item.kind}:${item.id}`,
    title: item.name,
    subtitle: item.kind === "series" ? "Series" : "Film",
    meta: [item.year, item.rating ? `★ ${item.rating}` : ""].filter(Boolean).join(" · ") || undefined,
    image: item.logo ?? undefined,
    kind: "poster" as const,
    href: railCardHref(item),
  }));
}

export interface FavouriteChannelInput {
  id: number | string;
  name: string;
  logo?: string | null;
  /** Real current programme from the EPG, when the guide has one. */
  nowTitle?: string | null;
  nextTitle?: string | null;
}

/** Favourite Live Channels — fitted logos, real now/next, never invented. */
export function favouriteChannelCards(channels: FavouriteChannelInput[]): HomeCard[] {
  return channels.slice(0, HOME_RAIL_LIMIT).map((channel) => ({
    key: `live:${channel.id}`,
    title: channel.name,
    subtitle: channel.nowTitle ?? "Live TV",
    meta: channel.nextTitle ? `Next: ${channel.nextTitle}` : undefined,
    image: channel.logo ?? undefined,
    kind: "channel" as const,
    href: `/livetv?channel=${encodeURIComponent(channel.id)}`,
  }));
}

/**
 * Hidden Gems: well-rated titles (≥ 7.5, the same bar as Discover's
 * "Hidden Gems" mood) the household has not watched, favourited, or
 * dismissed — best-rated first. No popularity signal exists in the
 * catalogue, so "hidden" here honestly means "highly rated and
 * unwatched", never a fabricated obscurity score.
 */
export function hiddenGemCards(
  candidates: DiscoverCandidate[],
  watchedKeys: Set<string>,
  excludedKeys: Set<string> = new Set(),
  limit: number = HOME_RAIL_LIMIT,
): HomeCard[] {
  return candidates
    .filter((c) => (c.kind === "movie" || c.kind === "series"))
    .filter((c) => typeof c.rating === "number" && c.rating >= HIDDEN_GEM_MIN_RATING)
    .filter((c) => !watchedKeys.has(candidateKey(c)))
    .filter((c) => !excludedKeys.has(candidateKey(c)))
    .sort((a, b) => {
      if ((b.rating ?? 0) !== (a.rating ?? 0)) return (b.rating ?? 0) - (a.rating ?? 0);
      return a.title.localeCompare(b.title);
    })
    .slice(0, limit)
    .map((candidate) => ({
      key: candidateKey(candidate),
      title: candidate.title,
      subtitle: candidate.kind === "series" ? "Series" : "Film",
      meta: candidateMeta(candidate),
      image: candidate.posterUrl,
      kind: "poster" as const,
      href: candidateDetailHref(candidate),
    }));
}

export interface HeroPick {
  candidate: DiscoverCandidate;
  /** Honest source label: where the hero title came from. */
  eyebrow: string;
}

/**
 * Cinematic hero from a REAL catalogue title, personally relevant
 * first: what you're mid-way through, else your top Picked for You,
 * else the newest arrival. Returns null when the library has nothing
 * with artwork to feature — the view then falls back to the branded
 * art in public/art/, never to an invented title.
 */
export function pickHero(input: {
  continueWatching: DiscoverCandidate[];
  picked: RankedCandidate[];
  recentlyAdded: DiscoverCandidate[];
}): HeroPick | null {
  const withArt = (c: DiscoverCandidate | undefined): c is DiscoverCandidate =>
    !!c && !!c.posterUrl;
  const fromContinue = input.continueWatching.find(withArt);
  if (fromContinue) return { candidate: fromContinue, eyebrow: "Continue Watching" };
  const fromPicked = input.picked.map((r) => r.candidate).find(withArt);
  if (fromPicked) return { candidate: fromPicked, eyebrow: "Picked for You" };
  const fromRecent = input.recentlyAdded.find(withArt);
  if (fromRecent) return { candidate: fromRecent, eyebrow: "Recently Added" };
  return null;
}

export interface HomeRailsInput {
  continueWatching: HomeCard[];
  newEpisodes: HomeCard[];
  picked: HomeCard[];
  trendingSource: TrendingSource;
  trending: HomeCard[];
  recentlyAdded: HomeCard[];
  continueSeries: HomeCard[];
  favouriteChannels: HomeCard[];
  hiddenGems: HomeCard[];
}

/**
 * Assemble the home rails in the fixed order, rendering a row ONLY
 * when it has meaningful data. An empty row is omitted, never an
 * empty shell — the gamepad rail model simply skips it.
 */
export function buildHomeRails(input: HomeRailsInput): HomeRail[] {
  const rails: HomeRail[] = [];
  if (input.continueWatching.length) {
    rails.push({
      id: "continue-watching",
      title: "Continue Watching",
      cards: input.continueWatching,
    });
  }
  if (input.newEpisodes.length) {
    rails.push({
      id: "new-episodes",
      title: "New Episodes",
      subtitle: "From the series you follow",
      href: "/followed",
      cards: input.newEpisodes,
    });
  }
  if (input.picked.length) {
    rails.push({
      id: "picked-for-you",
      title: "Picked for You",
      subtitle: "Based on what you've watched and loved",
      href: "/browse",
      cards: input.picked,
    });
  }
  if (input.trending.length) {
    rails.push({
      id: "trending",
      title: trendingSourceLabel(input.trendingSource),
      subtitle: "Matched to what's in your library",
      cards: input.trending,
    });
  }
  if (input.recentlyAdded.length) {
    rails.push({
      id: "recently-added",
      title: "Recently Added Movies",
      href: "/recently-added",
      cards: input.recentlyAdded,
    });
  }
  if (input.continueSeries.length) {
    rails.push({
      id: "continue-series",
      title: "Continue Your Series",
      href: "/browse?type=series",
      cards: input.continueSeries,
    });
  }
  if (input.favouriteChannels.length) {
    rails.push({
      id: "favourite-channels",
      title: "Favourite Live Channels",
      href: "/livetv",
      cards: input.favouriteChannels,
    });
  }
  if (input.hiddenGems.length) {
    rails.push({
      id: "hidden-gems",
      title: "Hidden Gems",
      subtitle: "Highly rated, not watched yet",
      href: "/browse",
      cards: input.hiddenGems,
    });
  }
  return rails;
}
