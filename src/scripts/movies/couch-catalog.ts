// Couch catalogue loading (W4) — one loader for the Movies and Series
// Couch browse screens.
//
// Reuses the app's existing catalogue path end to end: the active
// playlist entry, the shared cache (`cachedFetch` / `getCached` /
// `hydrate`, 24h TTL), the Xtream list actions, and the provider
// category map. The only Couch-specific part is the row mapping, which
// each screen supplies (mapMovieRow / mapSeriesRow). No new network
// code, no new cache.

import { getActiveEntry, loadCreds } from "@/scripts/lib/creds.js";
import { xtreamApiFetch } from "@/scripts/lib/xtream-api.js";
import {
  cachedFetch,
  getCached,
  hydrate as hydrateCache,
} from "@/scripts/lib/cache.js";
import { fetchCategoryMap } from "@/scripts/lib/grid-view.ts";
import { log } from "@/scripts/lib/log.js";

export interface CouchCatalogLoad<T> {
  rows: T[];
  playlistId: string;
  playlistTitle: string;
  /** True when the rows came from the shared cache. */
  fromCache: boolean;
  /** True when the provider fetch failed (rows may still be cached rows). */
  loadError: boolean;
}

export interface CouchCatalogSpec<T> {
  kind: "vod" | "series";
  listAction: "get_vod_streams" | "get_series";
  categoriesAction: "get_vod_categories" | "get_series_categories";
  ttlMs: number;
  mapRow: (raw: unknown, categoryMap: Map<string, string> | null) => T | null;
}

/** null = no active playlist (the screen shows its empty state). */
export async function loadCouchCatalog<T>(
  spec: CouchCatalogSpec<T>,
): Promise<CouchCatalogLoad<T> | null> {
  const active = await getActiveEntry();
  if (!active) return null;
  const playlistId = active._id as string;
  const playlistTitle = (active.title as string) || "";

  await hydrateCache(playlistId, spec.kind);
  const hit = getCached(playlistId, spec.kind);
  if (hit?.data) {
    return {
      rows: hit.data as T[],
      playlistId,
      playlistTitle,
      fromCache: true,
      loadError: false,
    };
  }

  const creds = await loadCreds();
  if (!creds.host || !creds.user || !creds.pass) {
    return { rows: [], playlistId, playlistTitle, fromCache: false, loadError: false };
  }

  const fetchRows = async (): Promise<T[]> => {
    const catMap = await fetchCategoryMap(spec.categoriesAction);
    const r = await xtreamApiFetch(spec.listAction);
    const body = await r.text();
    if (!r.ok) {
      log.error("Upstream error body:", body);
      throw new Error(`API ${r.status}: ${body}`);
    }
    const parsed = JSON.parse(body);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed?.movies || parsed?.series || parsed?.results || [];
    return (arr || [])
      .map((raw: unknown) => spec.mapRow(raw, catMap))
      .filter((row: T | null): row is T => row !== null);
  };

  try {
    const { data, fromCache } = await cachedFetch(playlistId, spec.kind, spec.ttlMs, fetchRows);
    return { rows: data as T[], playlistId, playlistTitle, fromCache, loadError: false };
  } catch (err) {
    log.error(`[xt:couch-${spec.kind}] load failed:`, err);
    return { rows: [], playlistId, playlistTitle, fromCache: false, loadError: true };
  }
}
