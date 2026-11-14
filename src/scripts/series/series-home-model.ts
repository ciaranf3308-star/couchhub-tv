// Series Home model (0.11.8, W4) — pure section builders for the
// Series Home screen. No DOM, no storage, no network: every function
// takes the data it needs and returns paintable view models, so the
// safety rules below are provable under vitest.
//
// SAFETY RULES (brief §4.2, §4.3, §14 — read before changing this file):
//
// 1. NEVER PLAY THE WRONG EPISODE. A Continue Watching card links to
//    a specific episode (detail URL with season/episode + autoplay)
//    ONLY when that episode is reliably determined: either the
//    viewer's own in-progress entry names its season/episode, or the
//    CACHED episode list proves the resume/next episode. When neither
//    holds, the card opens the plain series detail page and the viewer
//    selects — the card says "Open series", never "Continue".
// 2. DETECTION IS NOT BROADCAST. A new-episode card says "Detected
//    <date>" — when the provider upload was noticed by the followed
//    check. It never says premiered/aired/released: the provider
//    upload date is not the official TV premiere date.
// 3. NO FALSE NEW-EPISODE ALERTS. New-episode items come ONLY from
//    the followed.ts notification groups (unread, not dismissed),
//    which are created by the snapshot-diff engine with its
//    bulk-remap / truncation guards. This module invents no alerts
//    and re-derives no diffs.
// 4. NO SEASON-COMPLETENESS CLAIMS. Nothing here claims a series is
//    complete, or that every season/episode is available. Season
//    counts appear only when cached provider data supplies them (the
//    render layer reads the cache; this module claims nothing).
// 5. HONEST LABELLING. Shelf subtitles describe what the shelf IS
//    ("Recommended series you haven't started yet"). Nothing here
//    claims AI, personalisation, or curation it does not have.

import { buildSeriesDetailUrl } from "@/scripts/lib/followed.ts";
import type {
  FollowedNotificationGroup,
  FollowedSubscription,
} from "@/scripts/lib/followed.ts";
import {
  CANONICAL_SERIES_GENRES,
  genreLabelForId,
  genresForEntry,
  type CanonicalSeriesFamily,
} from "@/scripts/lib/genres.ts";
import type { CatalogIndex } from "@/scripts/lib/catalog-index.ts";
import {
  compareByRatingEvidence,
  hasCredibleRating,
  normaliseRating,
} from "@/scripts/lib/rating-evidence.ts";
import {
  selectAiRankedPicks,
  selectHiddenGems,
  selectRecentlyAdded,
  selectSeriesWorthStarting,
  selectSomethingDifferent,
  type SelectorResult,
} from "@/scripts/lib/collection-selectors.ts";
import {
  allocateShelves,
  HOME_SHELF_LIMITS,
  SHELF_POOL_OVERFETCH,
} from "@/scripts/lib/home-shelf-variety.ts";
import {
  groundedReasonForAiCard,
  homeAiSourceNote,
  type HomeAiPick,
  type HomeAiSource,
} from "@/scripts/lib/home-ai-picks.ts";
import {
  discoverPromptsFor,
  type DiscoverEntryPrompt,
} from "@/scripts/lib/home-discover-entries.ts";
import type { TasteModel } from "@/scripts/lib/taste.ts";
import {
  episodeDisplayTitle,
  groupEpisodesBySeason,
  resumeOrNextEpisode,
  seriesMetaLine,
  type EpisodeProgress,
  type SeasonGroup,
  type SeriesRow,
} from "@/scripts/series/couch-series.ts";

export const SERIES_HOME_SHELF_LIMIT = 12;
/** AI Series Picks shelf size (0.11.14 §12–§13). */
export const SERIES_AI_PICKS_LIMIT = HOME_SHELF_LIMITS.aiPicks;
/** Worth Starting shelf size (0.11.14 §15: richer rows). */
export const SERIES_WORTH_STARTING_LIMIT = HOME_SHELF_LIMITS.worthWatching;
/** Something Different / Undiscovered shelf sizes (0.11.14 §14). */
export const SERIES_SOMETHING_DIFFERENT_LIMIT = HOME_SHELF_LIMITS.somethingDifferent;
export const SERIES_UNDISCOVERED_LIMIT = HOME_SHELF_LIMITS.hiddenGems;
/** Recently Added shelf size (0.11.14 §15). */
export const SERIES_RECENTLY_ADDED_LIMIT = HOME_SHELF_LIMITS.recentlyAdded;

// ---------------------------------------------------------------------------
// Detail URLs
// ---------------------------------------------------------------------------

/** Plain series detail URL (no autoplay) — the safe default target. */
export function seriesDetailHref(seriesId: number | string): string {
  return `/series/detail?id=${encodeURIComponent(String(seriesId))}`;
}

// ---------------------------------------------------------------------------
// Continue Watching (§4.2)
// ---------------------------------------------------------------------------

/**
 * The viewer's most recent progress entry for one series, as recorded
 * by the existing progress store (preferences.js). Season/episode
 * numbers come from the entry itself — they were recorded when that
 * episode played, so they name the episode the viewer was watching.
 */
export interface SeriesHomeProgressEntry {
  episodeId: number | string | null;
  season: number | null;
  episodeNum: number | null;
  episodeTitle?: string | null;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
}

export interface ContinueWatchingInput {
  row: SeriesRow;
  /** Most recent progress entry, or null when the series has no entries. */
  lastProgress: SeriesHomeProgressEntry | null;
  /** Any recorded episode incomplete (getSeriesEpisodeProgress). */
  hasIncompleteEpisode: boolean;
  /** Recorded completed episode ids (getSeriesEpisodeProgress). */
  completedIds: number[];
  /**
   * Episode list from ALREADY-CACHED series info ONLY. Null when no
   * cached payload exists — callers must never fetch to fill this in
   * (brief §1.8/§15.6: shelves use cached season data; no enqueueing
   * for offscreen series). A null group means "next episode unknown",
   * never "no next episode".
   */
  cachedGroup: SeasonGroup | null;
  /** Progress keyed by episode id, for cached-group resolution. */
  progressByEpisodeId: Map<number, EpisodeProgress>;
}

export interface ContinueWatchingItem {
  row: SeriesRow;
  /** Stable focus key: `series-<id>`. */
  key: string;
  /** "S2 E4" for the episode this card is about, or "" when unknown. */
  episodeLabel: string;
  /** Episode title, only when the provider/progress record supplies one. */
  episodeTitle: string | null;
  /** What pressing the card does, in the viewer's words. */
  actionLabel: "Continue" | "Watch next episode" | "Open series";
  /** Autoplay episode URL when the episode is reliable, else the plain detail URL. */
  href: string;
  /** Watched fraction of the in-progress episode, 0 when not applicable. */
  progressFraction: number;
  /** Card subtitle, e.g. "Continue · S2 E4 · 63%". Poster
   * cards render ONE secondary line (the shared CSS hides the meta
   * line when a subtitle exists), so the subtitle carries every
   * fact the viewer must see: action, episode, and progress. */
  subtitle: string;
  /** Card meta line (DOM record; the poster rule hides it visually
   * when a subtitle is present — never the only home of a fact). */
  meta: string;
  /** updatedAt of the last progress entry (recency ordering). */
  lastTouchedAt: number;
  /** True only when href names a reliably determined episode. */
  episodeReliable: boolean;
}

function episodeCode(season: number, episodeNum: number): string {
  return `S${season} E${episodeNum}`;
}

function progressFractionOf(entry: SeriesHomeProgressEntry | null): number {
  if (!entry || !(entry.duration > 0) || entry.completed) return 0;
  return Math.max(0, Math.min(1, (entry.position || 0) / entry.duration));
}

function titleFromCachedGroup(
  group: SeasonGroup | null,
  season: number,
  episodeNum: number,
  seriesName: string,
): string | null {
  if (!group) return null;
  const eps = group.bySeason.get(season) ?? [];
  const ep = eps.find((candidate) => candidate.episodeNum === episodeNum);
  if (!ep) return null;
  const title = episodeDisplayTitle(ep, seriesName);
  return title || null;
}

/**
 * Build one Continue Watching card, or null when the series has no
 * honest claim on the shelf (no history at all, or provably fully
 * watched against the cached episode list).
 *
 * Resolution order (safest first):
 *  1. An in-progress entry naming its season/episode resumes THAT
 *     episode — the viewer's own record of what was playing.
 *  2. The cached episode list proves a resume/next episode.
 *  3. Otherwise the card opens the detail page ("Open series") with
 *     the last-watched episode named as history, never as "next".
 */
export function buildContinueWatchingItem(
  input: ContinueWatchingInput,
): ContinueWatchingItem | null {
  const { row, lastProgress, hasIncompleteEpisode, completedIds, cachedGroup } = input;
  const hasAnyHistory =
    lastProgress != null || hasIncompleteEpisode || completedIds.length > 0;
  if (!hasAnyHistory) return null;

  const base = {
    row,
    key: `series-${row.id}`,
    lastTouchedAt: lastProgress?.updatedAt ?? 0,
  };

  // 1. In-progress entry with known S/E: resume that exact episode.
  if (
    lastProgress &&
    !lastProgress.completed &&
    lastProgress.season != null &&
    lastProgress.episodeNum != null &&
    lastProgress.season > 0 &&
    lastProgress.episodeNum > 0
  ) {
    const label = episodeCode(lastProgress.season, lastProgress.episodeNum);
    const title =
      lastProgress.episodeTitle?.trim() ||
      titleFromCachedGroup(cachedGroup, lastProgress.season, lastProgress.episodeNum, row.name) ||
      null;
    const fraction = progressFractionOf(lastProgress);
    return {
      ...base,
      episodeLabel: label,
      episodeTitle: title,
      actionLabel: "Continue",
      href: buildSeriesDetailUrl({
        seriesId: String(row.id),
        season: lastProgress.season,
        episode: lastProgress.episodeNum,
      }),
      progressFraction: fraction,
      subtitle:
        fraction > 0
          ? `Continue · ${label} · ${Math.round(fraction * 100)}%`
          : `Continue · ${label}`,
      meta: fraction > 0 ? `${Math.round(fraction * 100)}% watched` : `Started · ${label}`,
      episodeReliable: true,
    };
  }

  // 2. Cached episode list proves resume/next. When the list proves
  //    everything is watched, the series leaves the shelf.
  if (cachedGroup && cachedGroup.totalEpisodes > 0) {
    const resolved = resumeOrNextEpisode(cachedGroup, input.progressByEpisodeId);
    if (!resolved) return null;
    const ep = resolved.episode;
    const label = episodeCode(ep.season, ep.episodeNum);
    const title = episodeDisplayTitle(ep, row.name) || null;
    const progress = input.progressByEpisodeId.get(ep.id);
    const fraction =
      resolved.label === "Resume" && progress?.duration
        ? Math.max(0, Math.min(1, (progress.position || 0) / progress.duration))
        : 0;
    const isResume = resolved.label === "Resume";
    return {
      ...base,
      episodeLabel: label,
      episodeTitle: title,
      actionLabel: isResume ? "Continue" : "Watch next episode",
      href: buildSeriesDetailUrl({
        seriesId: String(row.id),
        season: ep.season,
        episode: ep.episodeNum,
      }),
      progressFraction: fraction,
      subtitle: isResume
        ? fraction > 0
          ? `Continue · ${label} · ${Math.round(fraction * 100)}%`
          : `Continue · ${label}`
        : title
          ? `Next up · ${label} · ${title}`
          : `Next up · ${label}`,
      meta:
        isResume && fraction > 0
          ? `${Math.round(fraction * 100)}% watched`
          : title ?? label,
      episodeReliable: true,
    };
  }

  // 3. No reliable episode: open the detail page. Only series with an
  //    unfinished episode (or a last-watched record with no cached
  //    list to disprove more episodes) belong here — a series whose
  //    only records are completions, with no cached list and nothing
  //    unfinished, has no honest "continue" claim.
  if (lastProgress?.completed && !hasIncompleteEpisode && !cachedGroup) return null;
  if (!lastProgress && !hasIncompleteEpisode) return null;
  const label =
    lastProgress?.season != null &&
    lastProgress?.episodeNum != null &&
    lastProgress.season > 0 &&
    lastProgress.episodeNum > 0
      ? episodeCode(lastProgress.season, lastProgress.episodeNum)
      : "";
  // The episode is unreliable (no cached list to prove S/E), but the
  // position within the last-watched episode IS known from the record
  // alone — surface it as the progress bar + subtitle % (brief §4.2)
  // instead of discarding it. The % refers to that episode only.
  const fraction = progressFractionOf(lastProgress ?? null);
  const pct = Math.round(fraction * 100);
  return {
    ...base,
    episodeLabel: label,
    episodeTitle: lastProgress?.episodeTitle?.trim() || null,
    actionLabel: "Open series",
    href: seriesDetailHref(row.id),
    progressFraction: fraction,
    subtitle:
      label && fraction > 0
        ? `Last watched ${label} · ${pct}%`
        : label
          ? `Last watched ${label}`
          : fraction > 0
            ? `Pick up where you left off · ${pct}% into the episode`
            : "Pick up where you left off",
    meta: seriesMetaLine(row, null),
    episodeReliable: false,
  };
}

/** Most-recently-touched first, capped at the shelf limit. */
export function buildContinueWatching(
  inputs: ContinueWatchingInput[],
  limit: number = SERIES_HOME_SHELF_LIMIT,
): ContinueWatchingItem[] {
  const items: ContinueWatchingItem[] = [];
  for (const input of inputs) {
    const item = buildContinueWatchingItem(input);
    if (item) items.push(item);
  }
  items.sort(
    (a, b) =>
      b.lastTouchedAt - a.lastTouchedAt ||
      a.row.name.localeCompare(b.row.name, "en", { sensitivity: "base" }),
  );
  return items.slice(0, Math.max(0, limit));
}

/**
 * Build a SeasonGroup from a cached get_series_info payload, or null
 * when the payload is absent/unusable. Thin wrapper over
 * groupEpisodesBySeason so callers pass raw cache data, never a
 * fetch promise.
 */
export function cachedSeasonGroup(payload: unknown): SeasonGroup | null {
  if (!payload || typeof payload !== "object") return null;
  const group = groupEpisodesBySeason(payload);
  return group.totalEpisodes > 0 ? group : null;
}

// ---------------------------------------------------------------------------
// New Episodes from Followed Series (§4.3)
// ---------------------------------------------------------------------------

/** "Detected 12 Nov 2026" — detection wording only, never a premiere claim. */
export function formatDetectedLabel(detectedAt: string): string {
  const date = new Date(detectedAt);
  if (Number.isNaN(date.getTime())) return "Detected recently";
  try {
    return `Detected ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`;
  } catch {
    return "Detected recently";
  }
}

/**
 * Short detection date for the card badge ("11 Nov" / "Nov 11",
 * viewer's locale), or "" when the timestamp is unusable. Poster
 * cards render one secondary line, so the badge is what makes the
 * detection date visible at a glance; the full label stays in the
 * meta line and the aria-label.
 */
export function formatDetectedShort(detectedAt: string): string {
  const date = new Date(detectedAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
  } catch {
    return "";
  }
}

export interface NewEpisodeItem {
  /** Stable focus key: series + S/E + detection timestamp. */
  key: string;
  seriesId: string;
  seriesTitle: string;
  posterUrl: string | null;
  season: number;
  episode: number;
  episodeTitle: string | null;
  detectedAt: string;
  detectedLabel: string;
  /** Badge text: "New · 11 Nov" (status + detection date, always visible). */
  badgeLabel: string;
  /** "S3 E2 · Title" or "S3 E2" — only supplied parts. */
  subtitle: string;
  /** Watch this episode (detail URL with autoplay). */
  watchHref: string;
  /** Open the series (plain detail URL; X on the card does the same). */
  openHref: string;
}

export interface NewEpisodesOptions {
  /** True when the episode is already watched (excluded from the shelf). */
  isWatched?: (
    seriesId: string,
    season: number,
    episode: number,
    episodeId: number | null,
  ) => boolean;
  limit?: number;
}

/**
 * Genuine newly detected episodes, newest detection first. Only
 * unread, non-dismissed groups feed the shelf; watched episodes are
 * excluded when the caller supplies a watched check. Returns [] when
 * there is nothing genuine to show — the renderer omits the section
 * entirely rather than rendering an empty "new episodes" row.
 */
export function buildNewEpisodeItems(
  groups: FollowedNotificationGroup[],
  opts: NewEpisodesOptions = {},
): NewEpisodeItem[] {
  const limit = opts.limit ?? SERIES_HOME_SHELF_LIMIT;
  const seen = new Set<string>();
  const items: NewEpisodeItem[] = [];
  const ordered = [...groups]
    .filter((group) => !group.read && !group.dismissed)
    .sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
  for (const group of ordered) {
    const episodes = [...group.episodes].sort(
      (a, b) => a.season - b.season || a.episode - b.episode,
    );
    for (const ep of episodes) {
      if (opts.isWatched?.(group.seriesId, ep.season, ep.episode, ep.episodeId ?? null)) continue;
      const dedupeKey = `${group.seriesId}|${ep.season}|${ep.episode}|${group.detectedAt}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const title = (ep.episodeTitle || "").trim() || null;
      const label = episodeCode(ep.season, ep.episode);
      const short = formatDetectedShort(group.detectedAt);
      items.push({
        key: `series-${group.seriesId}-s${ep.season}e${ep.episode}-${group.detectedAt}`,
        seriesId: group.seriesId,
        seriesTitle: group.seriesTitle,
        posterUrl: group.posterUrl ?? ep.posterUrl ?? null,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: title,
        detectedAt: group.detectedAt,
        detectedLabel: formatDetectedLabel(group.detectedAt),
        badgeLabel: short ? `New · ${short}` : "New",
        subtitle: title ? `${label} · ${title}` : label,
        watchHref: buildSeriesDetailUrl({
          seriesId: group.seriesId,
          season: ep.season,
          episode: ep.episode,
        }),
        openHref: seriesDetailHref(group.seriesId),
      });
    }
  }
  return items.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Followed Series shelf (§4.3 fallback)
// ---------------------------------------------------------------------------

export interface FollowedShelfItem {
  /** Stable focus key: `series-<id>`. */
  key: string;
  seriesId: string;
  title: string;
  posterUrl: string | null;
  href: string;
  /** Catalogue meta line when the series is in the catalogue, else "". */
  meta: string;
}

/**
 * Compact Followed Series shelf, shown INSTEAD of the New Episodes
 * shelf when the viewer follows series but has no new episodes.
 * Catalogue rows win for artwork/meta; a followed series missing
 * from the current catalogue still shows with its subscription
 * title/poster (real followed.ts data, never invented).
 */
export function buildFollowedShelfItems(
  subscriptions: FollowedSubscription[],
  rowsById: Map<number, SeriesRow>,
  limit: number = SERIES_HOME_SHELF_LIMIT,
): FollowedShelfItem[] {
  const ordered = [...subscriptions].sort((a, b) =>
    a.seriesTitle.localeCompare(b.seriesTitle, "en", { sensitivity: "base" }),
  );
  return ordered.slice(0, Math.max(0, limit)).map((sub) => {
    const row = rowsById.get(Number(sub.seriesId));
    return {
      key: `series-${sub.seriesId}`,
      seriesId: sub.seriesId,
      title: row?.name || sub.seriesTitle,
      posterUrl: row?.logo || sub.posterUrl,
      href: seriesDetailHref(sub.seriesId),
      meta: row ? seriesMetaLine(row, null) : "",
    };
  });
}

// ---------------------------------------------------------------------------
// Explore Series Genres (§4.6)
// ---------------------------------------------------------------------------

export interface SeriesGenreTile {
  family: CanonicalSeriesFamily;
  /** Real count of catalogue series in this family. */
  count: number;
  /**
   * Artwork of the highest-rated series in the family — real
   * catalogue art, or null when no member has artwork (the tile then
   * renders typographically; placeholder art is never used).
   */
  artworkUrl: string | null;
  /** Title of the series the artwork belongs to (for honest alt text). */
  artworkTitle: string | null;
  /** Browse Everything genre param for this family. */
  browseGenreParam: string;
}

/**
 * Genre tiles for the 15 television families. Only non-empty families
 * are returned, in canonical family order. Counts come from the W1
 * index's display-level genre buckets, so a tile count ALWAYS equals
 * the Browse result count for that family; artwork is the
 * highest-evidence member's real catalogue art, or absent.
 */
export function buildSeriesGenreTiles(index: CatalogIndex): SeriesGenreTile[] {
  const tiles: SeriesGenreTile[] = [];
  for (const family of CANONICAL_SERIES_GENRES) {
    const primaryIds = index.idsByGenre.get(family.id) ?? [];
    if (primaryIds.length === 0) continue;
    const members: SeriesRow[] = [];
    for (const id of primaryIds) {
      const row = index.byId.get(id) as SeriesRow | undefined;
      if (row) members.push(row);
    }
    const withArt = members
      .filter((row) => row.logo)
      .sort(
        (a, b) =>
          compareByRatingEvidence(normaliseRating(a), normaliseRating(b)) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
    const art = withArt[0];
    tiles.push({
      family,
      count: members.length,
      artworkUrl: art?.logo ?? null,
      artworkTitle: art?.name ?? null,
      browseGenreParam: family.id,
    });
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Section assembly (§1.1, §2, §4) — order + omission rules in one place
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recommendation shelf items (0.11.14 §14, §20, §22)
// ---------------------------------------------------------------------------

/**
 * One recommendation-shelf card: a SERIES row plus its grounded
 * reason. Series recommendations ALWAYS link to the series
 * (seriesDetailHref) — never to a season or episode. The render
 * layer builds hrefs from `row.id` only; no episode identity ever
 * reaches this type.
 */
export interface SeriesShelfItem {
  row: SeriesRow;
  /** Grounded reason for the focus overlay, or null when nothing honest can be said. */
  reason: string | null;
}

/** The AI action for the Series Home AI sections (same honesty rule as Movies Home). */
export interface SeriesHomeAiAction {
  kind: "generate" | "request-fresh" | "none";
  label: string;
  hint: string;
}

export function chooseSeriesHomeAiAction(input: {
  aiConfigured: boolean;
  hasVerifiedPicks: boolean;
}): SeriesHomeAiAction {
  if (!input.aiConfigured) return { kind: "none", label: "", hint: "" };
  if (input.hasVerifiedPicks) {
    return {
      kind: "request-fresh",
      label: "Request fresh AI picks",
      hint: "Requests fresh picks from your AI provider — one request.",
    };
  }
  return {
    kind: "generate",
    label: "Generate AI Picks",
    hint: "Uses your configured AI provider — one request. Results are cached for a day.",
  };
}

/** On-page Discover entry-point results (brief §21), resolved to series rows by the mount. */
export interface SeriesDiscoverResults {
  prompt: DiscoverEntryPrompt;
  items: SeriesShelfItem[];
  source: HomeAiSource;
  note: string;
  /** Forward-contract Discover URL (W3 consumes ?q=&kind= when it lands). */
  discoverHref: string;
}

export type SeriesHomeSection =
  | {
      kind: "continue";
      id: "series-home-continue";
      title: "Continue Watching";
      items: ContinueWatchingItem[];
    }
  | {
      kind: "new-episodes";
      id: "series-home-new-episodes";
      title: "New Episodes";
      subtitle: string;
      items: NewEpisodeItem[];
    }
  | {
      kind: "followed";
      id: "series-home-followed";
      title: "Followed Series";
      items: FollowedShelfItem[];
    }
  | {
      kind: "ai-picks";
      id: "series-home-ai-picks";
      title: "AI Series Picks for You";
      subtitle: string;
      items: SeriesShelfItem[];
      source: HomeAiSource;
      action: SeriesHomeAiAction;
    }
  | {
      kind: "ai-prompt";
      id: "series-home-ai-prompt";
      title: "AI Series Picks for You";
      subtitle: string;
      action: SeriesHomeAiAction;
      /** Honest note when AI was attempted but unavailable (local shelves stay). */
      note: string | null;
    }
  | {
      kind: "discover-entries";
      id: "series-home-discover-entries";
      title: "Find something with AI";
      subtitle: string;
      prompts: DiscoverEntryPrompt[];
    }
  | {
      kind: "discover-results";
      id: "series-home-discover-results";
      title: string;
      subtitle: string;
      items: SeriesShelfItem[];
      source: HomeAiSource;
      discoverHref: string;
    }
  | {
      kind: "worth-starting";
      id: "series-home-worth-starting";
      title: "Series Worth Starting";
      subtitle: string;
      items: SeriesRow[];
      /** Grounded focus reasons by series id (local evidence, never AI-labelled). */
      reasons?: Record<string, string>;
    }
  | {
      kind: "something-different";
      id: "series-home-something-different";
      title: "Something Different";
      subtitle: string;
      items: SeriesShelfItem[];
    }
  | {
      kind: "undiscovered";
      id: "series-home-undiscovered";
      title: "Undiscovered Series";
      subtitle: string;
      items: SeriesShelfItem[];
    }
  | {
      kind: "recently-added";
      id: "series-home-recently-added";
      title: "Recently Added";
      items: SeriesRow[];
    }
  | {
      kind: "genres";
      id: "series-home-genres";
      title: "Explore Series Genres";
      items: SeriesGenreTile[];
    }
  | {
      kind: "browse-entry";
      id: "series-home-browse-entry";
      title: "Browse Everything";
      totalCount: number;
    };

export const NEW_EPISODES_SUBTITLE = "New episodes detected from the series you follow";
export const WORTH_STARTING_SUBTITLE = "Recommended series you haven't started yet";
export const SOMETHING_DIFFERENT_SUBTITLE = "Good series outside your usual genres";
export const UNDISCOVERED_SUBTITLE = "Well-rated series that rarely get surfaced";
export const DISCOVER_ENTRIES_SUBTITLE = "Ask AI for in-library picks, right here — one request per tap";

export interface SeriesHomeAssemblyInput {
  /** W1 catalog index (series kind) — the single source for shelves, tiles, and counts. */
  index: CatalogIndex;
  rowsById: Map<number, SeriesRow>;
  continueInputs: ContinueWatchingInput[];
  /** Notification groups for the ACTIVE playlist only (caller filters). */
  notificationGroups: FollowedNotificationGroup[];
  /** Subscriptions for the ACTIVE playlist only (caller filters). */
  subscriptions: FollowedSubscription[];
  /** Local taste model for Worth Starting (null = no taste signal). */
  taste: TasteModel | null | undefined;
  /** String ids of series with any recorded progress (excluded from Worth Starting). */
  startedIds: Iterable<string | number>;
  isEpisodeWatched?: NewEpisodesOptions["isWatched"];
  /** Verified AI picks in model order. Ignored unless `aiAllowed` is true. */
  aiPicks?: HomeAiPick[] | null;
  /** True only when verified AI input may be shown (privacy conditions met). */
  aiAllowed?: boolean;
  /** What actually produced `aiPicks` — the shelf label source. */
  aiSource?: HomeAiSource;
  /** Model id behind `aiPicks`, when known. */
  aiModel?: string;
  /** Honest note when AI was attempted but unavailable (shown with local shelves). */
  aiNote?: string | null;
  /** True when an AI request could run (enabled + endpoint + model set). */
  aiConfigured?: boolean;
  /** On-page Discover entry-point results to show, when the viewer tapped a prompt. */
  discoverResults?: SeriesDiscoverResults | null;
}

/**
 * Assemble the home shelf stack in display order. Empty sections are
 * omitted — Continue Watching hides with no history, New Episodes
 * hides with no genuine detections, and the Followed shelf appears
 * only when series are followed but no new episodes exist. The
 * Browse Everything entry always closes the stack when the catalogue
 * is non-empty. An empty catalogue yields no sections (the caller
 * renders the honest empty state).
 */
export function assembleSeriesHomeSections(
  input: SeriesHomeAssemblyInput,
): SeriesHomeSection[] {
  if (input.index.totalGroups === 0) return [];
  const sections: SeriesHomeSection[] = [];

  const continuing = buildContinueWatching(input.continueInputs);
  if (continuing.length > 0) {
    sections.push({
      kind: "continue",
      id: "series-home-continue",
      title: "Continue Watching",
      items: continuing,
    });
  }

  const newEpisodes = buildNewEpisodeItems(input.notificationGroups, {
    isWatched: input.isEpisodeWatched,
  });
  if (newEpisodes.length > 0) {
    sections.push({
      kind: "new-episodes",
      id: "series-home-new-episodes",
      title: "New Episodes",
      subtitle: NEW_EPISODES_SUBTITLE,
      items: newEpisodes,
    });
  } else if (input.subscriptions.length > 0) {
    const followed = buildFollowedShelfItems(input.subscriptions, input.rowsById);
    if (followed.length > 0) {
      sections.push({
        kind: "followed",
        id: "series-home-followed",
        title: "Followed Series",
        items: followed,
      });
    }
  }

  // D26: the selector cache does not fingerprint the started-set
  // contents, so the cache key carries them explicitly.
  const startedList = [...input.startedIds].map(String).sort();
  const cacheKeyBase = [
    "series-home",
    input.index.revision,
    `started:${startedList.join(",")}`,
  ].join("|");

  const resolvePool = (
    results: SelectorResult[],
  ): Array<{ id: string; row: SeriesRow; reason: string | null }> => {
    const items: Array<{ id: string; row: SeriesRow; reason: string | null }> = [];
    for (const result of results) {
      const row = input.index.byId.get(result.id) as SeriesRow | undefined;
      if (row) items.push({ id: result.id, row, reason: result.reasons[0] ?? null });
    }
    return items;
  };

  // Verified AI picks (0.11.14 §20): series primaries only, model
  // order preserved. A pick naming anything that is not a series in
  // THIS index is dropped by the selector — it can never link to an
  // episode, because episode identity never reaches a shelf item.
  const aiAllowed = input.aiAllowed === true && Array.isArray(input.aiPicks);
  const aiResults = aiAllowed
    ? selectAiRankedPicks(input.index, input.aiPicks, input.taste, SERIES_AI_PICKS_LIMIT, {
        excludeWatched: true,
        watchedIds: startedList,
      })
    : [];
  const aiPool = resolvePool(aiResults).map((item) => {
    const result = aiResults.find((candidate) => candidate.id === item.id)!;
    const rating = normaliseRating(item.row);
    const year = item.row.year ? String(item.row.year) : "";
    const genres = genresForEntry(item.row, "series")
      .slice(0, 2)
      .map((id) => genreLabelForId(id, "series"));
    return {
      ...item,
      reason: groundedReasonForAiCard({
        modelReason: result.reasons[0] ?? null,
        selectorReasons: result.reasons.slice(1),
        genres,
        ratingLabel: hasCredibleRating(rating) ? `★ ${rating!.score10.toFixed(1)}` : "",
        year,
      }),
    };
  });
  const aiSource: HomeAiSource = aiResults.length > 0 ? (input.aiSource ?? "ai") : "local";

  // Worth Starting stays LOCAL (§14): no AI input is passed, and
  // series with ANY recorded progress are excluded (already
  // started, not "worth starting").
  const worthResults = selectSeriesWorthStarting(
    input.index,
    input.taste,
    SERIES_WORTH_STARTING_LIMIT * SHELF_POOL_OVERFETCH,
    {
      watchedIds: startedList,
      cacheKey: `${cacheKeyBase}|worth`,
    },
  );
  const worthPool = resolvePool(worthResults);
  const worthReasons: Record<string, string> = {};
  for (const result of worthResults) {
    if (result.reasons[0]) worthReasons[result.id] = result.reasons[0];
  }

  const differentResults = selectSomethingDifferent(
    input.index,
    input.taste,
    SERIES_SOMETHING_DIFFERENT_LIMIT * SHELF_POOL_OVERFETCH,
    {
      watchedIds: startedList,
      excludeWatched: true,
      cacheKey: `${cacheKeyBase}|different`,
    },
  );
  const differentPool = resolvePool(differentResults);

  const undiscoveredResults = selectHiddenGems(
    input.index,
    input.taste,
    SERIES_UNDISCOVERED_LIMIT * SHELF_POOL_OVERFETCH,
    {
      watchedIds: startedList,
      excludeWatched: true,
      cacheKey: `${cacheKeyBase}|undiscovered`,
    },
  );
  const undiscoveredPool = resolvePool(undiscoveredResults);

  // Recently Added is factual: no quality gate, no taste filter.
  const recentPool = resolvePool(
    selectRecentlyAdded(
      input.index,
      SERIES_RECENTLY_ADDED_LIMIT * SHELF_POOL_OVERFETCH,
      null,
      { cacheKey: `${cacheKeyBase}|recent` },
    ),
  );

  // Cross-shelf allocation with backfill (§14/§15): the first shelf
  // keeps a contested title; later shelves refill from their own
  // pools. Continue/New/Followed are factual shelves and are not
  // part of this allocation.
  const allocated = allocateShelves([
    { id: "ai", items: aiPool, limit: SERIES_AI_PICKS_LIMIT },
    { id: "worth", items: worthPool, limit: SERIES_WORTH_STARTING_LIMIT },
    { id: "different", items: differentPool, limit: SERIES_SOMETHING_DIFFERENT_LIMIT },
    { id: "undiscovered", items: undiscoveredPool, limit: SERIES_UNDISCOVERED_LIMIT },
    { id: "recent", items: recentPool, limit: SERIES_RECENTLY_ADDED_LIMIT },
  ]);
  const byId = new Map(allocated.map((shelf) => [shelf.id, shelf.items]));
  const aiItems: SeriesShelfItem[] = (byId.get("ai") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const worthStarting = (byId.get("worth") ?? []).map((item) => item.row);
  const differentItems: SeriesShelfItem[] = (byId.get("different") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const undiscoveredItems: SeriesShelfItem[] = (byId.get("undiscovered") ?? []).map((item) => ({
    row: item.row,
    reason: item.reason,
  }));
  const recent = (byId.get("recent") ?? []).map((item) => item.row);

  const hasVerifiedPicks = aiItems.length > 0;
  const aiAction = chooseSeriesHomeAiAction({
    aiConfigured: input.aiConfigured === true,
    hasVerifiedPicks,
  });
  if (hasVerifiedPicks) {
    sections.push({
      kind: "ai-picks",
      id: "series-home-ai-picks",
      title: "AI Series Picks for You",
      subtitle: homeAiSourceNote(aiSource, input.aiModel),
      items: aiItems,
      source: aiSource,
      action: aiAction,
    });
  } else if (input.aiConfigured === true) {
    // AI is configured but no verified picks exist yet: the Generate
    // action is prominent, and an honest note explains a failed
    // attempt — local shelves below carry the page either way.
    sections.push({
      kind: "ai-prompt",
      id: "series-home-ai-prompt",
      title: "AI Series Picks for You",
      subtitle: "AI-ranked series from your own library",
      action: aiAction,
      note: input.aiNote ?? null,
    });
  }

  // Discover entry points (§21): lightweight chips, always present
  // (local fallback when AI is off). Results render directly below
  // when the viewer tapped a prompt.
  sections.push({
    kind: "discover-entries",
    id: "series-home-discover-entries",
    title: "Find something with AI",
    subtitle: DISCOVER_ENTRIES_SUBTITLE,
    prompts: discoverPromptsFor("series"),
  });
  if (input.discoverResults && input.discoverResults.items.length > 0) {
    sections.push({
      kind: "discover-results",
      id: "series-home-discover-results",
      title: `Results for “${input.discoverResults.prompt.label}”`,
      subtitle: input.discoverResults.note,
      items: input.discoverResults.items,
      source: input.discoverResults.source,
      discoverHref: input.discoverResults.discoverHref,
    });
  }

  if (worthStarting.length > 0) {
    sections.push({
      kind: "worth-starting",
      id: "series-home-worth-starting",
      title: "Series Worth Starting",
      subtitle: WORTH_STARTING_SUBTITLE,
      items: worthStarting,
      reasons: worthReasons,
    });
  }

  if (differentItems.length > 0) {
    sections.push({
      kind: "something-different",
      id: "series-home-something-different",
      title: "Something Different",
      subtitle: SOMETHING_DIFFERENT_SUBTITLE,
      items: differentItems,
    });
  }

  if (undiscoveredItems.length > 0) {
    sections.push({
      kind: "undiscovered",
      id: "series-home-undiscovered",
      title: "Undiscovered Series",
      subtitle: UNDISCOVERED_SUBTITLE,
      items: undiscoveredItems,
    });
  }

  if (recent.length > 0) {
    sections.push({
      kind: "recently-added",
      id: "series-home-recently-added",
      title: "Recently Added",
      items: recent,
    });
  }

  const genres = buildSeriesGenreTiles(input.index);
  if (genres.length > 0) {
    sections.push({
      kind: "genres",
      id: "series-home-genres",
      title: "Explore Series Genres",
      items: genres,
    });
  }

  sections.push({
    kind: "browse-entry",
    id: "series-home-browse-entry",
    title: "Browse Everything",
    totalCount: input.index.totalGroups,
  });
  return sections;
}

/**
 * Meta line for a Worth Starting / Recently Added card: year, cached
 * season count when the caller supplies one, provider category, and
 * the rating label only when the rating has evidence. No
 * season-completeness claim is ever produced here — a supplied
 * season count is cached provider data, and its absence simply omits
 * the part.
 */
export function seriesHomeCardMeta(
  row: SeriesRow,
  cachedSeasonCount: number | null,
): string {
  const parts: string[] = [];
  const base = seriesMetaLine(row, cachedSeasonCount);
  if (base) parts.push(base);
  const rating = normaliseRating(row);
  if (hasCredibleRating(rating)) {
    parts.push(`★ ${rating!.score10.toFixed(1)}`);
  }
  return parts.join(" · ");
}
