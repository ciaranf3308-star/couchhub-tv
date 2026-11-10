// RedSilk Couch — Live TV data layer (W1, canonical owner).
//
// Pure + cache-only reads for the rebuilt Live TV Home, Channel
// Browser and (via import) the playback / Guide screens. Nothing
// here fetches: channels come from the already-cached playlist
// (live-catalog), favourites / recents from the preferences store,
// programmes from the already-loaded EPG (epg-data sync read).
// When a source has nothing, the answer is empty / null — never
// invented titles, logos, programmes or viewing data.
//
// Shared contracts W2/W3 build against:
//   - event names below (livetv:tune / livetv:mode / livetv:overlay /
//     livetv:programme) and dispatchLivetvTune(), the playback
//     handoff (dispatches tune + mode; W2's playback shell / the
//     engine seam does the tuning — this module never touches the
//     player). The tune event is dispatched cancelable: a consumer
//     that handles it calls preventDefault() so the Home shell's
//     transitional ?channel= fallback (livetv.astro) stays out of
//     the way. Highlighted ≠ tuned, always.
//   - LIVETV_STATE_KEYS + LIVETV_STATE_COPY: the empty / error
//     states every Live TV screen reuses,
//   - the LivetvChannel shape (raw provider rows are untyped; this
//     is the typed contract the UI renders from). `category` is the
//     raw provider category (W2's field); `categoryId` is the same
//     raw value (the identity, kept verbatim) and `categoryLabel`
//     is its cleaned display label.
//   - loadLivetvChannels / loadLivetvProgrammes /
//     activeLivetvPlaylistId / nowNextForChannel /
//     favouriteChannels / recentlyWatchedChannels accept the call
//     shapes W2's shell already uses (no-arg loads resolve the
//     active playlist; playlistId args read favourites / recents
//     from preferences) as well as the flag/recents forms in the
//     W1 brief. Both spellings are the same function, not a copy.
//
// Channel identity is ALWAYS the provider id — except for the
// W7 dedupe, which collapses true duplicates only on reliable
// matching information (same id, same stream URL, or same
// quality-stripped name + same tvg-id with no conflicting logo).
// Distinct channels are never merged on similar names; same-name
// survivors are labelled distinctly instead.
import { getActiveEntry } from "./creds.js";
import { hydrate as hydrateCache } from "./cache.js";
import {
  readCachedLiveChannels,
  ensureOverridesReady,
} from "./live-catalog";
import {
  ensureLoaded as ensurePrefsLoaded,
  getFavorites,
  getRecents,
} from "./preferences.js";
import {
  getProgrammesSync,
  getNowNextForChannel,
} from "./epg-data.js";
import { programmeProgress } from "./couch-livetv-epg";
import type { Programme } from "./now-next";
import type { GuideMode, LivetvBrowserFilter } from "./livetv-state.js";
import { normalize } from "./text";
import { channelSupportsCatchup, type CatchupCapableChannel } from "./catchup";

// ── Events (shared contract) ────────────────────────────────────

export const LIVETV_TUNE_EVENT = "livetv:tune";
export const LIVETV_MODE_EVENT = "livetv:mode";
export const LIVETV_OVERLAY_EVENT = "livetv:overlay";
export const LIVETV_PROGRAMME_EVENT = "livetv:programme";

export type LivetvMode = "landing" | "browser" | "playback" | "guide";

/** Legacy mode name, accepted wherever a mode is accepted. */
export type LivetvModeInput = LivetvMode | "home";

/** Detail carried on `livetv:mode` (0.9.0). */
export interface LivetvModeDetail {
  mode: LivetvMode;
  browserFilter?: LivetvBrowserFilter;
  guideMode?: GuideMode;
  openSearch?: boolean;
}

/**
 * Playback handoff. Dispatches cancelable `livetv:tune`
 * {channelId} then `livetv:mode` {mode:"playback"} on window. A
 * consumer that tunes (W2's shell / engine seam) calls
 * preventDefault() on the tune event — the Home shell's
 * transitional ?channel= fallback only fires when nobody consumed
 * it. Callers dispatch this only on an explicit Watch/select
 * action, never on highlight or focus.
 */
export function dispatchLivetvTune(channelId: string | number): boolean {
  if (typeof window === "undefined") return false;
  const handled = !window.dispatchEvent(
    new CustomEvent(LIVETV_TUNE_EVENT, {
      detail: { channelId },
      cancelable: true,
    }),
  );
  window.dispatchEvent(
    new CustomEvent(LIVETV_MODE_EVENT, { detail: { mode: "playback" } }),
  );
  return handled;
}

/** Ask the shell to show a mode. Legacy "home" maps to "landing".
 *  Optional detail carries the browser filter / guide sub-mode /
 *  open-search entry flag the mode should open with (0.9.0). */
export function requestLivetvMode(
  mode: LivetvMode | "home",
  detail?: {
    browserFilter?: LivetvBrowserFilter;
    guideMode?: GuideMode;
    openSearch?: boolean;
  },
): void {
  if (typeof window === "undefined") return;
  const resolved: LivetvMode = mode === "home" ? "landing" : mode;
  window.dispatchEvent(
    new CustomEvent(LIVETV_MODE_EVENT, {
      detail: { ...detail, mode: resolved },
    }),
  );
}

// ── Empty / error states (shared keys, W2/W3 reuse) ─────────────

export const LIVETV_STATE_KEYS = [
  "no-favourites",
  "no-recents",
  "missing-epg",
  "empty-category",
  "no-replay",
  "stream-unavailable",
  "provider-lost",
] as const;

export type LivetvStateKey = (typeof LIVETV_STATE_KEYS)[number];

export const LIVETV_STATE_COPY: Record<
  LivetvStateKey,
  { title: string; message: string }
> = {
  "no-favourites": {
    title: "No favourite channels yet",
    message: "Star a channel while browsing to pin it here.",
  },
  "no-recents": {
    title: "Nothing watched yet",
    message: "Channels you watch will appear here.",
  },
  "missing-epg": {
    title: "No programme guide yet",
    message:
      "Programme times will appear once the guide has loaded for this playlist.",
  },
  "empty-category": {
    title: "No channels in this category",
    message: "Try another category, or clear the search.",
  },
  "no-replay": {
    title: "No replay for this programme",
    message: "This channel does not offer catch-up for this programme.",
  },
  "stream-unavailable": {
    title: "This channel is unavailable",
    message: "The provider did not return a playable stream for it.",
  },
  "provider-lost": {
    title: "No live playlist connected",
    message: "Add a playlist to browse live channels.",
  },
};

// ── Channel shape ───────────────────────────────────────────────

export interface LivetvChannel {
  /** Provider id — Xtream rows use a number, M3U rows a string. Identity is always this. */
  id: string | number;
  /** Provider / override name. */
  name: string;
  /** Display name (override name when one exists, else the provider name). */
  displayName: string;
  logo: string | null;
  /** Raw provider category (W2's field). */
  category: string;
  /** Raw provider category — the identity, kept verbatim. Same value as `category`. */
  categoryId: string;
  /** Display label: normaliseCategoryLabel(categoryId). */
  categoryLabel: string;
  /** Direct stream URL when the cached row carries one (M3U rows); null for Xtream rows (URL is built at tune time). */
  streamUrl: string | null;
  tvgId: string | null;
  tvgShift?: number | null;
  chno?: number;
  /** True when the provider offers catch-up on this channel. */
  catchup: boolean;
  favourite: boolean;
  hidden: boolean;
  /** Cached normalised haystack: name + category + tvgId. */
  norm: string;
  /**
   * Ids of provider rows merged into this channel by dedupe
   * (dedupeLivetvChannels). Present only when rows were merged, so
   * no original stream identifier is ever silently lost.
   */
  duplicateIds?: (string | number)[];
}

/** Raw provider row shape (untyped upstream). Only the fields we read. */
export interface LivetvRawChannel {
  id?: string | number;
  name?: string;
  logo?: string | null;
  category?: string | null;
  categories?: string[];
  url?: string | null;
  tvgId?: string | null;
  tvgShift?: number | null;
  chno?: number | null;
  tvArchive?: number | string | null;
  tvArchiveDuration?: number | string | null;
  catchup?: unknown;
  catchupSource?: unknown;
  catchupDays?: number | string | null;
  hidden?: boolean;
  norm?: string;
  [key: string]: unknown;
}

export interface LivetvRecentEntry {
  id: string | number;
  name: string;
  logo: string | null;
  ts: number;
}

// ── Category labels ─────────────────────────────────────────────

/**
 * Display label for a raw provider category. Strips what is noise
 * for a human label — a leading country/region prefix ("UK | ",
 * "IE - ", "Sports (UK)"), resolution / quality tags (FHD, HD, 4K,
 * 1080p) and redundant punctuation — and collapses whitespace.
 * The raw value stays the identity (categoryId); only the label is
 * cleaned. "" / missing → "Uncategorized".
 *
 * NOTE for integration: W3's livetv-guide.ts carries a local copy
 * with a narrower rule (trim + collapse only, "ALL" reads as "All
 * categories"). This canonical version is the fuller rule; the
 * Guide's copy should be deleted and re-exported from here.
 */
export function normaliseCategoryLabel(raw: unknown): string {
  if (typeof raw !== "string") return "Uncategorized";
  let label = raw.trim();
  // Leading region prefix: "UK | Sports", "IE - News", "Ireland: Movies".
  label = label.replace(
    /^(?:UK|GB|IE|IRL|USA|US|Ireland|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland)\s*[-–—|:]\s*/i,
    "",
  );
  // Trailing region in parens: "Sports (UK)".
  label = label.replace(
    /\s*\((?:UK|GB|IE|IRL|USA|US|Ireland|United Kingdom|England|Scotland|Wales)\)\s*$/i,
    "",
  );
  // Resolution / quality tags.
  label = label.replace(/\b(?:FHD|UHD|4K|HD|SD|HEVC|H\.?265|1080p|720p|2160p)\b/gi, "");
  // Redundant separators / punctuation, then whitespace.
  label = label.replace(/[-–—_|:/]+/g, " ");
  label = label.replace(/\s{2,}/g, " ").trim();
  label = label.replace(/^[.,\s]+|[.,\s]+$/g, "");
  return label || "Uncategorized";
}

/** True when the channel's provider category names Ireland / the UK. */
const LOCAL_REGION_RE =
  /\b(?:UK|GB|IE|IRL|Ireland|United Kingdom|Great Britain|England|Scotland|Wales|Northern Ireland|British|Irish|RT[EÉ]|TG4)\b/i;

export function isLocalChannel(channel: LivetvChannel): boolean {
  return LOCAL_REGION_RE.test(channel.categoryId || "");
}

// ── Dedupe (W7) ────────────────────────────────────────────────

/**
 * Channel name as a dedupe key: the shared normaliser, then
 * trailing quality tags stripped ("BBC One FHD" / "BBC One HD" →
 * "bbc one"). Quality tags are provider mirrors of the same
 * broadcast, never a different channel. Region words are NOT
 * stripped — "BBC One Scotland" is a genuinely distinct regional
 * feed and must survive as its own (disambiguated) tile.
 */
export function normaliseChannelName(name: string): string {
  const n = normalize(name ?? "");
  return n
    .replace(/(?:\s+(?:fhd|uhd|4k|hd|sd|hevc|h265|1080p|720p|2160p))+$/g, "")
    .trim();
}

interface DedupeMergeTarget {
  kept: LivetvChannel;
  mergedIds: (string | number)[];
}

/**
 * Collapse TRUE duplicates — the rows that made Live TV Home show
 * BBC One twice, AFN Sports twice, Sky Cinema three times as
 * identical tiles side by side. Providers list the same broadcast
 * under several rows (quality mirrors, re-listed playlist entries);
 * nothing here ever merges on a similar name alone.
 *
 * A row merges into an earlier kept channel only on reliable
 * matching information, in this order:
 *   1. same provider id (String-compared, so M3U string ids work),
 *   2. same non-empty direct stream URL (M3U rows),
 *   3. same quality-stripped name AND same non-empty tvg-id, unless
 *      both rows carry a logo and the logos differ (different logos
 *      = possibly distinct feeds, so they survive for
 *      disambiguation instead).
 *
 * The first row wins (source order preserved); merged rows' ids are
 * kept on `duplicateIds`, and a kept row adopts a logo / tvg-id /
 * stream URL / favourite flag from a merged row only when it lacks
 * that value itself. A row is never dropped when its identity is
 * unproven — distinct channels that merely share a name survive and
 * are labelled distinctly by disambiguateLivetvDisplayNames.
 */
export function dedupeLivetvChannels(
  channels: readonly LivetvChannel[],
): LivetvChannel[] {
  const byId = new Map<string, DedupeMergeTarget>();
  const byUrl = new Map<string, DedupeMergeTarget>();
  const byNameTvg = new Map<string, DedupeMergeTarget>();
  const targets: DedupeMergeTarget[] = [];
  const out: LivetvChannel[] = [];

  const nameTvgKey = (channel: LivetvChannel): string | null =>
    channel.tvgId
      ? `${normaliseChannelName(channel.name)}|${channel.tvgId.toLowerCase()}`
      : null;

  const register = (channel: LivetvChannel): DedupeMergeTarget => {
    const target: DedupeMergeTarget = { kept: channel, mergedIds: [] };
    targets.push(target);
    byId.set(String(channel.id), target);
    if (channel.streamUrl) byUrl.set(channel.streamUrl, target);
    const key = nameTvgKey(channel);
    if (key) byNameTvg.set(key, target);
    out.push(channel);
    return target;
  };

  const mergeInto = (target: DedupeMergeTarget, row: LivetvChannel): void => {
    const kept = target.kept;
    target.mergedIds.push(row.id);
    if (!kept.logo && row.logo) kept.logo = row.logo;
    if (!kept.tvgId && row.tvgId) kept.tvgId = row.tvgId;
    if (!kept.streamUrl && row.streamUrl) kept.streamUrl = row.streamUrl;
    if (kept.chno == null && row.chno != null) kept.chno = row.chno;
    if (row.favourite) kept.favourite = true;
    // A merged row is hidden only when every copy is hidden; a
    // visible copy must never be swallowed by a hidden one.
    kept.hidden = kept.hidden && row.hidden;
    // A merged row's keys must keep pointing at the kept channel,
    // so a third mirror of the same broadcast merges too.
    byId.set(String(row.id), target);
    if (row.streamUrl) byUrl.set(row.streamUrl, target);
    const rowKey = nameTvgKey(row);
    if (rowKey) byNameTvg.set(rowKey, target);
    const keptKey = nameTvgKey(kept);
    if (keptKey) byNameTvg.set(keptKey, target);
  };

  for (const row of channels) {
    const idTarget = byId.get(String(row.id));
    if (idTarget) {
      mergeInto(idTarget, row);
      continue;
    }
    const urlTarget = row.streamUrl ? byUrl.get(row.streamUrl) : undefined;
    if (urlTarget) {
      mergeInto(urlTarget, row);
      continue;
    }
    let nameTvgTarget: DedupeMergeTarget | undefined;
    const rowKey = nameTvgKey(row);
    if (rowKey) nameTvgTarget = byNameTvg.get(rowKey);
    if (
      nameTvgTarget &&
      !(nameTvgTarget.kept.logo && row.logo && nameTvgTarget.kept.logo !== row.logo)
    ) {
      mergeInto(nameTvgTarget, row);
      continue;
    }
    register(row);
  }

  for (const target of targets) {
    if (target.mergedIds.length > 0) {
      target.kept.duplicateIds = [...target.mergedIds];
    }
  }
  return out;
}

/**
 * Label distinct channels that merely share a name so identical
 * tiles never sit side by side: after dedupe, any kept channels
 * whose names normalise equal get a qualifier on displayName —
 * the provider group / region label when it differs within the
 * group, else the channel number, else the tvg-id, else the id.
 * The raw `name` is never rewritten; only the display label gains
 * the qualifier. Groups of one are untouched.
 */
export function disambiguateLivetvDisplayNames(
  channels: readonly LivetvChannel[],
): LivetvChannel[] {
  const groups = new Map<string, LivetvChannel[]>();
  for (const channel of channels) {
    const key = normalize(channel.displayName || channel.name);
    const group = groups.get(key);
    if (group) group.push(channel);
    else groups.set(key, [channel]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const uniqueInGroup = (pick: (c: LivetvChannel) => string | null): boolean => {
      const values = group.map(pick);
      return new Set(values).size === values.length && values.every((v) => v != null && v !== "");
    };
    for (const channel of group) {
      let qualifier: string | null = null;
      if (uniqueInGroup((c) => c.categoryLabel || null)) {
        qualifier = channel.categoryLabel;
      } else if (uniqueInGroup((c) => (c.chno != null ? String(c.chno) : null))) {
        qualifier = `CH ${channel.chno}`;
      } else if (uniqueInGroup((c) => c.tvgId)) {
        qualifier = channel.tvgId;
      } else {
        qualifier = `#${channel.id}`;
      }
      channel.displayName = `${channel.name} — ${qualifier}`;
    }
  }
  return [...channels];
}

// ── Mapping (pure core of loadLivetvChannels) ───────────────────

export function mapLivetvChannels(
  rows: readonly LivetvRawChannel[],
  favouriteIds?: ReadonlySet<string | number> | Iterable<string | number> | null,
): LivetvChannel[] {
  const favs = new Set<string>();
  if (favouriteIds) {
    for (const id of favouriteIds) favs.add(String(id));
  }
  const out: LivetvChannel[] = [];
  for (const row of rows || []) {
    if (row == null) continue;
    const id = row.id;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (id == null || id === "" || !name) continue;
    const rawCategory =
      (typeof row.category === "string" && row.category.trim()) ||
      (Array.isArray(row.categories) && row.categories.length
        ? String(row.categories[0] ?? "")
        : "") ||
      "";
    const categoryLabel = normaliseCategoryLabel(rawCategory);
    const tvgId =
      typeof row.tvgId === "string" && row.tvgId.trim() ? row.tvgId.trim() : null;
    out.push({
      id,
      name,
      displayName: name,
      logo: typeof row.logo === "string" && row.logo.trim() ? row.logo.trim() : null,
      category: rawCategory,
      categoryId: rawCategory,
      categoryLabel,
      streamUrl: typeof row.url === "string" && row.url.trim() ? row.url.trim() : null,
      tvgId,
      tvgShift: typeof row.tvgShift === "number" ? row.tvgShift : null,
      chno: typeof row.chno === "number" ? row.chno : undefined,
      catchup: channelSupportsCatchup(row as CatchupCapableChannel),
      favourite: favs.has(String(id)),
      hidden: row.hidden === true,
      norm:
        typeof row.norm === "string" && row.norm
          ? row.norm
          : normalize(`${name} ${categoryLabel} ${tvgId ?? ""}`),
    });
  }
  // Providers re-list the same broadcast under several rows
  // (quality mirrors, re-listed entries): collapse true duplicates
  // on reliable identity, then label the distinct same-name
  // channels that remain so identical tiles never sit side by side.
  return disambiguateLivetvDisplayNames(dedupeLivetvChannels(out));
}

/** Active playlist id, or "" when no playlist is active. */
export async function activeLivetvPlaylistId(): Promise<string> {
  try {
    const active = await getActiveEntry();
    return active?._id ?? "";
  } catch {
    return "";
  }
}

/**
 * Cache-only read of a playlist's live channels with overrides +
 * favourite flags applied. Never fetches the playlist. No argument
 * resolves the active playlist (W2's call shape); an explicit id
 * uses it ("\" → []).
 */
export async function loadLivetvChannels(
  playlistId?: string,
): Promise<LivetvChannel[]> {
  const resolved =
    playlistId === undefined ? await activeLivetvPlaylistId() : playlistId;
  if (!resolved) return [];
  await ensureOverridesReady();
  const rows = readCachedLiveChannels(resolved) as LivetvRawChannel[];
  try {
    await ensurePrefsLoaded();
  } catch {
    // Preferences unreadable: channels still load, just unfavourited.
  }
  let favouriteIds: ReadonlySet<string | number> = new Set();
  try {
    favouriteIds = getFavorites(resolved, "live") ?? new Set();
  } catch {
    favouriteIds = new Set();
  }
  return mapLivetvChannels(rows, favouriteIds);
}

/**
 * Cached EPG programmes for a playlist (Map keyed by lower-cased
 * tvg-id), or an empty Map when no guide is loaded. No argument
 * resolves the active playlist. NOTE: getProgrammesSync returns the
 * EPG state object — this unwraps its `.programmes` Map; callers
 * must never be handed the state object as if it were the Map.
 */
export async function loadLivetvProgrammes(
  playlistId?: string,
): Promise<Map<string, Programme[]>> {
  const resolved =
    playlistId === undefined ? await activeLivetvPlaylistId() : playlistId;
  if (!resolved) return new Map();
  try {
    const state = getProgrammesSync(resolved) as {
      programmes?: Map<string, Programme[]>;
    } | null;
    return state?.programmes ?? new Map();
  } catch {
    return new Map();
  }
}

export interface LivetvHomeData {
  playlistId: string;
  channels: LivetvChannel[];
  recents: LivetvRecentEntry[];
  /** Cached EPG programmes (Map<tvgId, Programme[]>) or null when no guide is loaded. */
  programmes: Map<string, Programme[]> | null;
  hasEpg: boolean;
}

/** One cache-only load for the whole Live TV Home screen. */
export async function loadLivetvHomeData(
  playlistId: string,
): Promise<LivetvHomeData> {
  // W7: the engine hydrates the channel cache from IndexedDB at
  // boot, but Home used to read the in-memory map before that
  // landed — on a cold load it rendered "No live playlist
  // connected" with a warm cache sitting in IndexedDB, and nothing
  // ever re-rendered. Wait for hydration first (a no-op once the
  // cache is already in memory); a hydration failure still falls
  // through to the empty read, never breaks Home.
  if (playlistId) {
    try {
      await Promise.allSettled([
        hydrateCache(playlistId, "live"),
        hydrateCache(playlistId, "m3u"),
      ]);
    } catch {
      // See above: Home degrades to the empty read.
    }
  }
  const channels = await loadLivetvChannels(playlistId);
  let recents: LivetvRecentEntry[] = [];
  try {
    await ensurePrefsLoaded();
    recents = (getRecents(playlistId, "live") ?? []).map((entry: {
      id: string | number;
      name?: string;
      logo?: string | null;
      ts?: number;
    }) => ({
      id: entry.id,
      name: entry.name || "",
      logo: entry.logo ?? null,
      ts: entry.ts || 0,
    }));
  } catch {
    recents = [];
  }
  const state = playlistId
    ? (getProgrammesSync(playlistId) as {
        programmes?: Map<string, Programme[]>;
      } | null)
    : null;
  const programmes = state?.programmes ?? null;
  return {
    playlistId,
    channels,
    recents,
    programmes,
    hasEpg: !!programmes && programmes.size > 0,
  };
}

/**
 * Active playlist id from the xt_playlists blob (same rule TvChannelList used). "" when none.
 * When the stored selection matches no entry (stale selectedId),
 * the first entry wins over showing the provider-empty state for
 * a playlist that is really there — Home must not strand itself
 * on a dead selection.
 */
export function readActivePlaylistId(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    const raw = localStorage.getItem("xt_playlists") || "";
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const selected = entries.find((e: { _id?: string }) => e && e._id === parsed?.selectedId);
    const fallback = entries.find((e: { _id?: string }) => e && e._id);
    const entry = selected ?? fallback;
    return entry ? String(entry._id) : "";
  } catch {
    return "";
  }
}

// ── Grouping ────────────────────────────────────────────────────

export interface LivetvGroup {
  id: string;
  label: string;
  channels: LivetvChannel[];
}

interface LocalGroupDef {
  id: string;
  label: string;
  /** Regexes over the NORMALISED label (lowercased). First match wins. */
  match: RegExp;
}

const LOCAL_GROUP_DEFS: LocalGroupDef[] = [
  { id: "entertainment", label: "Entertainment", match: /entertainment|general|variety|lifestyle|reality|comedy|talk|shows?/ },
  { id: "sports", label: "Sports", match: /sport/ },
  { id: "news", label: "News", match: /news/ },
  { id: "movies", label: "Movies", match: /movi|film|cinema/ },
  { id: "documentaries", label: "Documentaries", match: /documentar|docu|nature|history|science|wildlife/ },
  { id: "kids", label: "Kids", match: /kid|children|cartoon|animation|family|junior/ },
  { id: "music", label: "Music", match: /music/ },
];

export const LIVETV_ALL_GROUP_ID = "all";

function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "group";
}

/**
 * Local groups with aliases, then provider groups as fallback.
 *
 * A channel lands in exactly one local/provider group (+ All
 * Channels): the genre match on its normalised label wins first, so
 * "UK | Sports" is Sports (it is still local for whatsOnNow
 * ordering); a channel with no genre keyword whose raw category
 * names Ireland / the UK is "Irish & UK" (pure region buckets such
 * as "UK", "Ireland", "UK Channels"); anything else keeps its
 * provider group, labelled by its normalised category, first-seen
 * order. Order: Irish & UK, Entertainment, Sports, News, Movies,
 * Documentaries, Kids, Music, provider groups, All Channels.
 */
export function groupChannels(channels: readonly LivetvChannel[]): LivetvGroup[] {
  const byId = new Map<string, LivetvGroup>();
  const order: LivetvGroup[] = [];
  const ensure = (id: string, label: string): LivetvGroup => {
    let group = byId.get(id);
    if (!group) {
      group = { id, label, channels: [] };
      byId.set(id, group);
      order.push(group);
    }
    return group;
  };
  // Irish & UK first so it can be placed first in the collections row.
  const irishUk = ensure("irish-uk", "Irish & UK");
  for (const channel of channels) {
    const labelLower = (channel.categoryLabel || "").toLowerCase();
    const def = LOCAL_GROUP_DEFS.find((d) => d.match.test(labelLower));
    if (def) {
      ensure(def.id, def.label).channels.push(channel);
      continue;
    }
    if (isLocalChannel(channel)) {
      irishUk.channels.push(channel);
      continue;
    }
    const label = channel.categoryLabel || "Uncategorized";
    ensure(`provider:${slugifyLabel(label)}`, label).channels.push(channel);
  }
  const groups = order.filter((g) => g.channels.length > 0);
  // Directive order for the local groups, provider groups keep
  // first-seen order after them, All Channels last.
  const localOrder = ["irish-uk", ...LOCAL_GROUP_DEFS.map((d) => d.id)];
  groups.sort((a, b) => {
    const ai = localOrder.indexOf(a.id);
    const bi = localOrder.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  groups.push({ id: LIVETV_ALL_GROUP_ID, label: "All Channels", channels: [...channels] });
  return groups;
}

// ── Search / filters ────────────────────────────────────────────

function numericTokenMatches(channel: LivetvChannel, token: string): boolean {
  const idText = String(channel.id);
  if (idText === token || idText.startsWith(token)) return true;
  if (channel.chno != null) {
    const chnoText = String(channel.chno);
    if (chnoText === token || chnoText.startsWith(token)) return true;
  }
  return false;
}

/**
 * Search by name (debounced by the caller). Tokens must all match
 * the channel's cached normalised haystack (name + category +
 * tvgId); a digits-only token also matches channel number / id
 * exactly or by prefix, mirroring the old list's behaviour.
 */
export function searchChannels(
  channels: readonly LivetvChannel[],
  query: string,
): LivetvChannel[] {
  const q = normalize(query ?? "").trim();
  if (!q) return [...channels];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...channels];
  return channels.filter((channel) =>
    tokens.every((token) =>
      /^\d+$/.test(token)
        ? numericTokenMatches(channel, token) || channel.norm.includes(token)
        : channel.norm.includes(token),
    ),
  );
}

/**
 * Favourite channels. Two call shapes, one rule (id match, String
 * compared — never Number(), so M3U string ids work too):
 *   - favouriteChannels(channels) → channels flagged favourite,
 *   - favouriteChannels(channels, playlistId) → favourites read
 *     from preferences for that playlist (W2's call shape).
 */
export function favouriteChannels(
  channels: readonly LivetvChannel[],
  playlistId?: string,
): LivetvChannel[] {
  if (playlistId === undefined) {
    return channels.filter((channel) => channel.favourite);
  }
  if (!playlistId) return [];
  let favs: ReadonlySet<string | number> | null = null;
  try {
    favs = getFavorites(playlistId, "live");
  } catch {
    return [];
  }
  if (!favs || favs.size === 0) return [];
  const favSet = new Set<string>();
  for (const id of favs) favSet.add(String(id));
  return channels.filter((channel) => favSet.has(String(channel.id)));
}

/**
 * Live-only recents, distinct by id, most-recent-first. Only
 * channels still in the catalogue are returned; a recent whose
 * channel is gone is dropped, never shown from stale metadata.
 * Never merges distinct channels on similar names — id match only.
 *
 * Two call shapes:
 *   - recentlyWatchedChannels(channels, recents) — recents entries
 *     (W1 brief shape),
 *   - recentlyWatchedChannels(channels, playlistId) — recents read
 *     from preferences for that playlist (W2's call shape).
 */
export function recentlyWatchedChannels(
  channels: readonly LivetvChannel[],
  source?: readonly LivetvRecentEntry[] | string | null,
  limit: number = 12,
): LivetvChannel[] {
  let recents: readonly { id: string | number }[] = [];
  if (typeof source === "string") {
    if (!source) return [];
    try {
      recents = getRecents(source, "live") ?? [];
    } catch {
      return [];
    }
  } else if (Array.isArray(source)) {
    recents = source;
  } else {
    return [];
  }
  const byId = new Map<string, LivetvChannel>();
  for (const channel of channels) {
    if (!byId.has(String(channel.id))) byId.set(String(channel.id), channel);
  }
  const out: LivetvChannel[] = [];
  const seen = new Set<string>();
  for (const recent of recents || []) {
    const key = String(recent.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const channel = byId.get(key);
    if (channel) out.push(channel);
    if (out.length >= Math.max(0, limit)) break;
  }
  return out;
}

// ── Now / Next ──────────────────────────────────────────────────

export interface LivetvNowNextProgramme {
  title: string;
  start: number;
  stop: number;
  desc: string;
  /** Elapsed fraction 0..1 (current programme only). */
  progress?: number;
}

export interface LivetvNowNext {
  current: LivetvNowNextProgramme | null;
  next: LivetvNowNextProgramme | null;
}

function toNowNextProgramme(
  p: Programme | null | undefined,
  atMs: number,
  withProgress: boolean,
): LivetvNowNextProgramme | null {
  if (!p) return null;
  return {
    title: p.title ?? "",
    start: p.start,
    stop: p.stop,
    desc: p.desc ?? "",
    ...(withProgress ? { progress: programmeProgress(p.start, p.stop, atMs) } : {}),
  };
}

function unwrapProgrammes(
  programmes: Map<string, Programme[]> | { programmes?: Map<string, Programme[]> } | null | undefined,
): Map<string, Programme[]> | null {
  if (!programmes) return null;
  if (programmes instanceof Map) return programmes;
  const maybe = (programmes as { programmes?: unknown }).programmes;
  return maybe instanceof Map ? maybe : null;
}

/**
 * Now/Next for one channel from cached EPG only. Null-safe: no
 * programmes, no tvgId or no match → {current: null, next: null}.
 * Never invents a programme. `programmes` is the Map from
 * loadLivetvProgrammes (a raw EPG state object is unwrapped
 * defensively). `playlistId` resolves the channel's EPG override
 * mapping; without it the channel's own tvg-id is used.
 */
export function nowNextForChannel(
  channel: LivetvChannel | null | undefined,
  programmes: Map<string, Programme[]> | { programmes?: Map<string, Programme[]> } | null | undefined,
  playlistId: string = "",
  atMs: number = Date.now(),
): LivetvNowNext {
  if (!channel) return { current: null, next: null };
  const map = unwrapProgrammes(programmes);
  if (!map) return { current: null, next: null };
  try {
    const { current, next } = getNowNextForChannel(map, channel as never, playlistId, atMs);
    return {
      current: toNowNextProgramme(current, atMs, true),
      next: toNowNextProgramme(next, atMs, false),
    };
  } catch {
    return { current: null, next: null };
  }
}

export interface ResumeHeroPick {
  channel: LivetvChannel;
  eyebrow: string;
}

/**
 * Resume hero pick (pure, so the Home screen and tests agree):
 * last watched channel first ("Resume Watching"); else a favourite
 * with a live programme now, else any favourite ("Favourite
 * Channel"); else the first channel with a live programme now
 * ("On Now"); else — first run with no history, no favourites and
 * no EPG coverage — a credible featured channel from the catalogue
 * ("Featured Channel"), preferring a local channel with a logo.
 * Null only when there are no channels at all. The hero must never
 * be a bare wall of logos on first run: a real channel is real
 * data, and programme lines still come from real EPG only (the
 * shell shows "Live TV" when there is no current programme).
 */
export function pickResumeHero(
  channels: readonly LivetvChannel[],
  recents: readonly LivetvRecentEntry[],
  programmes: Map<string, Programme[]> | { programmes?: Map<string, Programme[]> } | null | undefined,
  playlistId: string = "",
  atMs: number = Date.now(),
): ResumeHeroPick | null {
  const watched = recentlyWatchedChannels(channels, recents);
  if (watched[0]) return { channel: watched[0], eyebrow: "Resume Watching" };
  const favourites = favouriteChannels(channels);
  const favWithNow = favourites.find(
    (c) => nowNextForChannel(c, programmes, playlistId, atMs).current,
  );
  if (favWithNow) return { channel: favWithNow, eyebrow: "Favourite Channel" };
  if (favourites[0]) return { channel: favourites[0], eyebrow: "Favourite Channel" };
  const liveNow = channels.find(
    (c) => nowNextForChannel(c, programmes, playlistId, atMs).current,
  );
  if (liveNow) return { channel: liveNow, eyebrow: "On Now" };
  const featured =
    channels.find((c) => isLocalChannel(c) && c.logo) ??
    channels.find((c) => c.logo) ??
    channels[0];
  if (featured) return { channel: featured, eyebrow: "Featured Channel" };
  return null;
}

export interface CollectionNowPlaying {
  channelName: string;
  programmeTitle: string;
}

/**
 * The first live programme in a collection, from real EPG only
 * (null when the guide covers nothing in the group). Scans at most
 * the first 100 channels so a 15,000-channel group never pays for
 * a full EPG sweep to fill one card line. Never invents a
 * programme.
 */
export function collectionNowPlaying(
  group: LivetvGroup,
  programmes: Map<string, Programme[]> | { programmes?: Map<string, Programme[]> } | null | undefined,
  playlistId: string = "",
  atMs: number = Date.now(),
): CollectionNowPlaying | null {
  for (const channel of group.channels.slice(0, 100)) {
    const nn = nowNextForChannel(channel, programmes, playlistId, atMs);
    if (nn.current) {
      return { channelName: channel.displayName, programmeTitle: nn.current.title };
    }
  }
  return null;
}

export interface WhatsOnNowItem {
  channel: LivetvChannel;
  current: NonNullable<LivetvNowNext["current"]>;
  next: LivetvNowNext["next"];
  progress: number;
}

export interface WhatsOnNowOptions {
  playlistId?: string;
  favouriteIds?: Iterable<string | number> | null;
  watchedIds?: Iterable<string | number> | null;
  atMs?: number;
  limit?: number;
}

function toIdSet(ids: Iterable<string | number> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (ids) for (const id of ids) out.add(String(id));
  return out;
}

/**
 * What's On Now: channels with a real current programme, ordered
 * favourites first, then watched, then local (Irish & UK), then
 * everything else; ties by programme start, then name. Only
 * channels the EPG actually covers appear — no invented data.
 */
export function whatsOnNow(
  channels: readonly LivetvChannel[],
  programmes: Map<string, Programme[]> | { programmes?: Map<string, Programme[]> } | null | undefined,
  opts: WhatsOnNowOptions = {},
): WhatsOnNowItem[] {
  const atMs = opts.atMs ?? Date.now();
  const limit = opts.limit ?? 12;
  const favouriteIds = toIdSet(opts.favouriteIds);
  const watchedIds = toIdSet(opts.watchedIds);
  const items: (WhatsOnNowItem & { rank: number })[] = [];
  for (const channel of channels) {
    const slot = nowNextForChannel(channel, programmes, opts.playlistId ?? "", atMs);
    if (!slot.current) continue;
    const key = String(channel.id);
    const rank = favouriteIds.has(key)
      ? 0
      : watchedIds.has(key)
        ? 1
        : isLocalChannel(channel)
          ? 2
          : 3;
    items.push({
      channel,
      current: slot.current,
      next: slot.next,
      progress: slot.current.progress ?? 0,
      rank,
    });
  }
  items.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.current.start !== b.current.start) return a.current.start - b.current.start;
    return a.channel.displayName.localeCompare(b.channel.displayName);
  });
  return items.slice(0, Math.max(0, limit)).map(({ rank: _rank, ...item }) => item);
}
