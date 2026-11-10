// RedSilk Live TV — data layer (W1 contract, local copy).
//
// NOTE (W2): W1's canonical `livetv-data.ts` was not on this branch
// when W2 was built, so this file is a local copy written to the
// EXACT contract in the W2 brief. Integration keeps W1's canonical
// version and deletes this duplicate — same path, same exports, same
// `LivetvChannel` shape. Do not diverge the two; if they differ,
// W1's wins.
//
// All reads are cache-only: channels come from the already-loaded
// live catalog, programmes from the already-loaded EPG store. This
// module never fetches, never invents a programme, and never tunes.

import { getActiveEntry } from "./creds.js";
import { readCachedLiveChannels } from "./live-catalog";
import {
  getProgrammesSync,
  getNowNextForChannel,
} from "./epg-data.js";
import { getFavorites, getRecents } from "./preferences.js";

export interface LivetvChannel {
  id: string | number;
  name: string;
  displayName: string;
  logo?: string | null;
  chno?: number | null;
  category?: string | null;
  tvgId?: string | null;
  tvgShift?: number | null;
}

export interface LivetvNowNext {
  current: {
    title?: string;
    start: number;
    stop: number;
    desc?: string;
  } | null;
  next: {
    title?: string;
    start: number;
    stop: number;
    desc?: string;
  } | null;
}

function toLivetvChannel(raw: any): LivetvChannel {
  return {
    id: raw.id,
    name: raw.name ?? "",
    displayName: raw.displayName ?? raw.name ?? "",
    logo: raw.logo ?? null,
    chno: raw.chno ?? null,
    category: raw.category ?? raw.group ?? null,
    tvgId: raw.tvgId ?? null,
    tvgShift: raw.tvgShift ?? null,
  };
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

/** Cache-only channel list for the active playlist, in catalog order. */
export async function loadLivetvChannels(): Promise<LivetvChannel[]> {
  const playlistId = await activeLivetvPlaylistId();
  if (!playlistId) return [];
  const rows = readCachedLiveChannels(playlistId);
  return (Array.isArray(rows) ? rows : []).map(toLivetvChannel);
}

/** Cached EPG programmes for the active playlist (Map keyed by tvg-id). */
export async function loadLivetvProgrammes(): Promise<Map<string, any>> {
  const playlistId = await activeLivetvPlaylistId();
  if (!playlistId) return new Map();
  try {
    // getProgrammesSync returns the EpgState; the Map keyed by
    // tvg-id lives on `.programmes`.
    const state = getProgrammesSync(playlistId) as any;
    const programmes = state?.programmes;
    return programmes instanceof Map ? programmes : new Map();
  } catch {
    return new Map();
  }
}

/**
 * Now/next for one channel from cached EPG only. `playlistId` is an
 * optional third argument (the contract's two-arg call still works);
 * without it, tvg-id overrides are skipped and the channel's own
 * tvg-id is used. No programme is ever invented: missing EPG yields
 * nulls, never a fabricated title.
 */
export function nowNextForChannel(
  channel: LivetvChannel,
  programmes: Map<string, any>,
  playlistId?: string,
): LivetvNowNext {
  if (!channel || !programmes) return { current: null, next: null };
  const { current, next } = getNowNextForChannel(
    programmes,
    channel as any,
    playlistId ?? "",
  );
  const shape = (p: any) =>
    p
      ? {
          title: p.title ?? "",
          start: p.start,
          stop: p.stop,
          desc: p.desc ?? "",
        }
      : null;
  return { current: shape(current), next: shape(next) };
}

/** Channels the user favourited, in catalog order. */
export function favouriteChannels(
  channels: LivetvChannel[],
  playlistId: string,
): LivetvChannel[] {
  if (!playlistId) return [];
  const favs = getFavorites(playlistId, "live");
  if (!favs || favs.size === 0) return [];
  return channels.filter((channel) => favs.has(Number(channel.id)));
}

/** Channels recently watched, most recent first, in catalog order filtered to recents. */
export function recentlyWatchedChannels(
  channels: LivetvChannel[],
  playlistId: string,
): LivetvChannel[] {
  if (!playlistId) return [];
  const recents = getRecents(playlistId, "live") as Array<{
    id: string | number;
  }>;
  if (!recents || recents.length === 0) return [];
  const order = new Map<string, number>();
  recents.forEach((recent, index) => order.set(String(recent.id), index));
  return channels
    .filter((channel) => order.has(String(channel.id)))
    .sort(
      (a, b) =>
        (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0),
    );
}
