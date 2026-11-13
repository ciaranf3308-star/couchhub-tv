// RedSilk Couch — Guide data pipeline (Live TV 0.11.11, W3).
//
// The Guide's data path, factored out of TvGuideView.astro so the
// hot loops are testable without a DOM:
//
//   1. Indexed tvg-id resolution. `resolveTvgId` (epg-data.js) is a
//      pure function that rebuilds the whole normalised-name index
//      on EVERY call (up to 2x per channel: full name + stripped
//      prefix). At the user's 15,319 channels x 800 EPG names that
//      is a ~15s main-thread freeze on every EPG load (measured
//      2026-11-13, throttled sandbox CPU). The EPG state already
//      carries a pre-built `nameIndex` (built once per load in
//      loadProgrammes); `createGuideTvgResolver` uses it, or builds
//      the index exactly once when the state has none, and resolves
//      every channel through O(1) lookups with byte-identical
//      semantics to `resolveTvgId` (same order, same collision
//      refusal, same raw-tvg-id fallback).
//   2. Revision-cached Now/Next rows. `nowNextRows` linearly scans
//      every programme of every visible channel (~95ms at 15k
//      channels on the same CPU) and the Guide called it on EVERY
//      focus move. `createNowNextRowsCache` memoises the
//      current/next scan per (EPG revision, visible set, minute
//      bucket) and recomputes only the cheap progress fraction per
//      call, so arrowing through On Now no longer rescans the
//      catalogue. Rows can go stale by <60s within a minute bucket
//      (a programme boundary crossed mid-bucket); progress is
//      always fresh, and the next minute bucket or EPG revision
//      recomputes.
//   3. Evening-window Tonight collection. `collectTonightItems`
//      filters to the evening window DURING the channel loop
//      instead of wrapping every programme of every channel first
//      (2.25M wrapper objects + repeated full sorts at 15k x 150).
//      The window predicate is exactly `programmesForTonight`'s,
//      so the sections/fallback output is identical.
//   4. Failure signal. W4 owns the single failure-state classifier
//      (`guideDataState` in livetv-guide.ts — fixed precedence,
//      honest panel copy); this module defines NO second classifier.
//      It defines only the failure SIGNAL the classifier's
//      `loadFailed` input reads: `GuideFailureSignal` +
//      `resolveGuideLoadFailed`. Integration wires it with one
//      line at W4's seam (renderNow passes `loadFailed: false`
//      today): see resolveGuideLoadFailed's doc comment.
//
// Pure functions + small explicit caches. No DOM, no fetching, no
// invented listings. The EPG ingestion engine (epg-data.js) is
// untouched: this module only consumes its existing exports.

import {
  buildChannelNameIndex,
  findInChannelNameIndex,
  shiftChannelProgrammes,
  stripChannelNamePrefix,
} from "./epg-data.js";
import {
  normaliseCategoryLabel,
  nowNextRows,
  sanitiseGuideProgrammes,
  type GuideNowRow,
  type GuideProgramme,
  type RawGuideProgramme,
} from "./livetv-guide";
import { programmeProgress } from "./couch-livetv-epg";
import type { TonightChannel, TonightItem } from "./livetv-tonight";

// ── Indexed tvg-id resolution ────────────────────────────────────

/** Minimal channel shape resolution needs (cached catalogue rows). */
export interface GuideChannelLike {
  id: number | string;
  name?: string | null;
  displayName?: string | null;
  tvgId?: string | null;
  tvgShift?: unknown;
  category?: unknown;
  logo?: unknown;
}

/** The slice of EpgState the Guide's loader reads. */
export interface GuideEpgStateLike {
  programmes: Map<string, unknown>;
  channelNames?: Map<string, string> | null;
  /** Pre-built by loadProgrammes; absent for states built by hand. */
  nameIndex?: Map<string, string> | null;
}

/**
 * A batch tvg-id resolver: one index for the whole catalogue.
 * `resolve` has exactly `resolveTvgId`'s semantics (see
 * epg-data.js): override wins, then a raw tvg-id present in the
 * programmes map, then the unique normalised-name match, then the
 * same match on the provider-group prefix stripped name, then the
 * raw tvg-id (possibly "") as the fallback.
 */
export interface GuideTvgResolver {
  resolve(channel: GuideChannelLike | null | undefined): string;
  /** The index every resolve goes through — the state's pre-built
   *  one when present, else the single index built by the factory.
   *  Exposed so tests can prove the index is built once, not once
   *  per channel. */
  readonly nameIndex: Map<string, string>;
}

export function createGuideTvgResolver(
  state: GuideEpgStateLike | null | undefined,
  overrides: Record<string, string> | null | undefined,
): GuideTvgResolver {
  const programmes = state?.programmes ?? null;
  // Prefer the state's pre-built index; build exactly once from the
  // channel names when the state has none (hand-built states, tests).
  const nameIndex =
    state?.nameIndex instanceof Map
      ? state.nameIndex
      : buildChannelNameIndex(
          state?.channelNames ?? new Map<string, string>(),
        );
  const hasNames = nameIndex.size > 0;
  return {
    nameIndex,
    resolve(channel) {
      if (!channel) return "";
      const channelId = channel.id != null ? String(channel.id) : "";
      const overridden = channelId && overrides ? overrides[channelId] : "";
      if (overridden) return String(overridden).toLowerCase();
      const rawTvgId = channel.tvgId ? String(channel.tvgId).toLowerCase() : "";
      if (rawTvgId && programmes && programmes.has(rawTvgId)) return rawTvgId;
      if (channel.name && hasNames) {
        const match = findInChannelNameIndex(channel.name, nameIndex);
        if (match) return match;
        const stripped = stripChannelNamePrefix(channel.name);
        if (stripped && stripped !== channel.name) {
          const prefixMatch = findInChannelNameIndex(stripped, nameIndex);
          if (prefixMatch) return prefixMatch;
        }
      }
      return rawTvgId;
    },
  };
}

// ── Batch programme load ─────────────────────────────────────────

export interface LoadGuideProgrammesResult {
  /** Sanitised programmes per channel id (every day the EPG covers). */
  programmesByChannel: Map<string, GuideProgramme[]>;
  /** Channels whose resolved tvg-id had a programmes array. */
  mappedChannelCount: number;
  /** Channels with a non-empty resolved tvg-id (mapped or not). */
  resolvedChannelCount: number;
  /** Channel ids with no usable EPG mapping (no tvg-id resolved, or
   *  the resolved id has no programmes). Honest "no EPG" signal. */
  unmappedChannelIds: string[];
  /** Channel ids skipped because their programme data threw during
   *  shift/sanitise (corrupt cached rows). One bad channel must
   *  never abort the whole load. */
  failedChannelIds: string[];
  /** Total sanitised programmes across all channels. */
  totalProgrammes: number;
}

/**
 * Load every channel's programmes through one shared resolver.
 * Behaviour matches the Guide's previous inline loop exactly —
 * same lookup (lower-cased resolved id), same tvg-shift, same
 * sanitise — except a corrupt channel entry is skipped instead of
 * aborting the load, and resolution is indexed instead of O(M)
 * per channel. Returns empty maps (never throws) when there is no
 * usable EPG state.
 */
export function loadGuideProgrammes(
  channels: ReadonlyArray<GuideChannelLike>,
  state: GuideEpgStateLike | null | undefined,
  overrides: Record<string, string> | null | undefined,
): LoadGuideProgrammesResult {
  const programmesByChannel = new Map<string, GuideProgramme[]>();
  const unmappedChannelIds: string[] = [];
  const failedChannelIds: string[] = [];
  let mappedChannelCount = 0;
  let resolvedChannelCount = 0;
  let totalProgrammes = 0;
  const programmes = state?.programmes;
  if (!programmes) {
    return {
      programmesByChannel,
      mappedChannelCount,
      resolvedChannelCount,
      unmappedChannelIds: channels.map((channel) => String(channel.id)),
      failedChannelIds,
      totalProgrammes,
    };
  }
  const resolver = createGuideTvgResolver(state, overrides);
  for (const channel of channels) {
    const channelId = String(channel.id);
    let tvgId: string;
    try {
      tvgId = resolver.resolve(channel);
    } catch {
      // Resolution must not throw for well-formed channels; if it
      // ever does, treat the channel as unmapped and move on.
      unmappedChannelIds.push(channelId);
      continue;
    }
    if (!tvgId) {
      unmappedChannelIds.push(channelId);
      continue;
    }
    resolvedChannelCount += 1;
    const raw = programmes.get(String(tvgId).toLowerCase());
    if (!raw) {
      unmappedChannelIds.push(channelId);
      continue;
    }
    try {
      const shifted = shiftChannelProgrammes(
        raw as RawGuideProgramme[],
        channel.tvgShift as never,
      );
      const cleaned = sanitiseGuideProgrammes(
        channelId,
        shifted as unknown as ReadonlyArray<RawGuideProgramme>,
      );
      mappedChannelCount += 1;
      totalProgrammes += cleaned.length;
      programmesByChannel.set(channelId, cleaned);
    } catch {
      failedChannelIds.push(channelId);
    }
  }
  return {
    programmesByChannel,
    mappedChannelCount,
    resolvedChannelCount,
    unmappedChannelIds,
    failedChannelIds,
    totalProgrammes,
  };
}

// ── Revision-cached Now/Next rows ────────────────────────────────

const MINUTE_MS = 60_000;

/**
 * Memoised `nowNextRows` for the Guide's focus path. The expensive
 * scan runs only when the EPG revision, the visible channel set,
 * or the minute bucket changes; every other call reuses the
 * current/next pairs and recomputes only the progress fraction
 * (O(rows), cheap). Single-entry: the Guide has one visible set at
 * a time, and focus moves never change it.
 */
export interface NowNextRowsCache {
  getRows(args: {
    programmesByChannel: ReadonlyMap<string, ReadonlyArray<GuideProgramme>>;
    visibleChannels: ReadonlyArray<{ id: number | string }>;
    nowMs: number;
    /** EPG revision (the Guide's gridRevision): bumped on every
     *  programme load, so a fresh load always recomputes. */
    revision: number;
  }): GuideNowRow[];
  /** Drop the cached scan (tests / explicit invalidation). */
  invalidate(): void;
}

export function createNowNextRowsCache(): NowNextRowsCache {
  let cachedKey: string | null = null;
  let cachedBase: Array<{
    channelId: string;
    current: GuideProgramme;
    next: GuideProgramme | null;
  }> | null = null;
  return {
    getRows({ programmesByChannel, visibleChannels, nowMs, revision }) {
      const minuteBucket = Math.floor(nowMs / MINUTE_MS);
      // Exact visible-set key: ids in order, joined. Building it is
      // O(channels) string work (~1ms at 15k); the scan it guards
      // is ~95ms. A hash would risk showing another set's rows.
      let visibleKey = "";
      for (const channel of visibleChannels) {
        visibleKey += `${String(channel.id)},`;
      }
      const key = `${revision}|${minuteBucket}|${visibleKey}`;
      if (cachedBase !== null && cachedKey === key) {
        return cachedBase.map(({ channelId, current, next }) => ({
          channelId,
          current,
          next,
          progress: programmeProgress(current.startMs, current.stopMs, nowMs),
        }));
      }
      const visibleIds = new Set(visibleChannels.map((c) => String(c.id)));
      const filtered = new Map(
        [...programmesByChannel].filter(([id]) => visibleIds.has(id)),
      );
      const rows = nowNextRows(filtered, nowMs);
      cachedKey = key;
      cachedBase = rows.map(({ channelId, current, next }) => ({
        channelId,
        current,
        next,
      }));
      return rows;
    },
    invalidate() {
      cachedKey = null;
      cachedBase = null;
    },
  };
}

// ── Evening-window Tonight collection ────────────────────────────

export interface CollectTonightItemsOptions {
  /** Favourite channel ids (raw ids, as getFavorites returns). */
  favouriteIds: ReadonlySet<unknown>;
  /** Recently-watched channel ids (raw ids). */
  watchedIds: ReadonlySet<unknown>;
  /** Evening window from eveningWindowMs(nowMs) — the same window
   *  programmesForTonight filters to, so pre-filtering here cannot
   *  change the sections/fallback output. */
  windowStartMs: number;
  windowEndMs: number;
  /** Lower-cased, trimmed search query ("" = no search filter).
   *  Applied with the same predicate the Guide used on the
   *  unfiltered items, so search + window filtering commute. */
  searchNeedle?: string;
}

/**
 * Tonight items for the evening window, built in one pass. The
 * previous code wrapped EVERY programme of EVERY channel (2.25M
 * objects at 15k x 150) and let the section builders re-filter and
 * re-sort the lot (~4.6s on the throttled sandbox CPU). This
 * collects only programmes overlapping the evening window (and
 * matching the search, when set), building the per-channel Tonight
 * identity lazily on the first overlapping programme. Output is
 * identical to the old loop followed by programmesForTonight:
 * same items, same channel identity, same order per channel.
 */
export function collectTonightItems(
  channels: ReadonlyArray<GuideChannelLike>,
  programmesByChannel: ReadonlyMap<string, ReadonlyArray<GuideProgramme>>,
  options: CollectTonightItemsOptions,
): TonightItem[] {
  const { favouriteIds, watchedIds, windowStartMs, windowEndMs } = options;
  const needle = options.searchNeedle ?? "";
  const items: TonightItem[] = [];
  for (const channel of channels) {
    const list = programmesByChannel.get(String(channel.id));
    if (!list || list.length === 0) continue;
    let tonightChannel: TonightChannel | null = null;
    for (const programme of list) {
      if (
        programme.startMs >= windowEndMs ||
        programme.stopMs <= windowStartMs
      ) {
        continue;
      }
      if (!tonightChannel) {
        tonightChannel = {
          id: String(channel.id),
          displayName: channel.displayName || channel.name || "",
          logo: channel.logo ? String(channel.logo) : null,
          categoryLabel: normaliseCategoryLabel(channel.category || ""),
          favourite: favouriteIds.has(channel.id),
          watched: watchedIds.has(channel.id),
        };
      }
      if (needle) {
        const haystack =
          `${tonightChannel.displayName} ${programme.title} ${programme.desc ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      items.push({ programme, channel: tonightChannel });
    }
  }
  return items;
}

// ── Failure signal (W4 `loadFailed` seam) ────────────────────────

/**
 * The W3 failure signal: the data conditions behind the `loadFailed`
 * input of W4's `guideDataState` classifier (livetv-guide.ts), the
 * single classifier for the Guide's failure states. This module
 * defines no classifier of its own and no state strings — it only
 * names the two genuine-failure conditions the Guide observes:
 *
 *   pipelineFailed   — a data-pipeline throw was caught (activation
 *                      or the EPG handler) and no load has succeeded
 *                      since. Set from the Guide's `guideDataError`.
 *   epgSourcesFailed — every EPG source errored on the last
 *                      EPG source-status event. Set from the Guide's
 *                      `epgLoadFailed`.
 *
 * Both clear on a clean EPG load. Either one means the EPG load
 * genuinely failed (brief §16 state (e)): W4's classifier returns
 * "failure" and shows no listings rather than guessed ones.
 *
 * INTEGRATION WIRE (one line, at W4's seam in renderNow, which
 * passes `loadFailed: false` today):
 *
 *   loadFailed: resolveGuideLoadFailed({
 *     pipelineFailed: guideDataError !== null,
 *     epgSourcesFailed: epgLoadFailed,
 *   }),
 *
 * (adding `resolveGuideLoadFailed` to the livetv-guide-data.ts
 * import in TvGuideView.astro). The same wire applies to any other
 * mode renderer that calls `guideDataState`.
 */
export interface GuideFailureSignal {
  pipelineFailed: boolean;
  epgSourcesFailed: boolean;
}

/** The `loadFailed` value for W4's `guideDataState` classifier: true
 *  when either genuine-failure condition holds. */
export function resolveGuideLoadFailed(signal: GuideFailureSignal): boolean {
  return signal.pipelineFailed || signal.epgSourcesFailed;
}
