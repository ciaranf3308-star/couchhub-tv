// Stream URL builders shared between detail pages and the poster context menu.
// Single source of truth so detail and the right-click "Copy stream URL" item
// don't drift apart on encoding, extension, or path shape.

import { fmtBase } from "@/scripts/lib/creds.js"
import {
  probeVodContainerAlternative,
  swapUrlExtension,
} from "@/scripts/lib/vod-container-probe.ts"

interface Creds {
  host: string
  port?: string | number
  user: string
  pass: string
}

/**
 * Build the canonical Xtream VOD stream URL for a movie. Mirrors the path
 * `movies/detail.ts` constructs when no `stream_url` override is present.
 *
 * Extension defaults to `mp4` when the provider didn't tag the movie with one.
 * Username, password and movieId are URL-encoded so providers with `/` or
 * spaces in any of those fields don't break the path.
 */
export function buildMovieStreamUrl(
  creds: Creds,
  movieId: string | number,
  containerExt: string | null | undefined
): string {
  const rawExt = containerExt || "mp4"
  const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
  return (
    fmtBase(creds.host, creds.port).replace(/\/+$/, "") +
    "/movie/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(String(movieId)) +
    "." +
    ext
  )
}

/**
 * Build the canonical Xtream VOD stream URL for a series episode. Mirrors
 * the path `series/detail.ts` constructs when the episode has no
 * `_directUrl` override (see `buildEpisodeStreamUrl` there).
 *
 * Extension defaults to `mp4` when the provider didn't tag the episode with
 * one. Username, password and episodeId are URL-encoded so providers with
 * `/` or spaces in any of those fields don't break the path.
 */
export function buildSeriesStreamUrl(
  creds: Creds,
  episodeId: string | number,
  containerExt: string | null | undefined
): string {
  const rawExt = containerExt || "mp4"
  const ext = String(rawExt).replace(/^\.+/, "").toLowerCase() || "mp4"
  return (
    fmtBase(creds.host, creds.port).replace(/\/+$/, "") +
    "/series/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(String(episodeId)) +
    "." +
    ext
  )
}

/** Canonical Xtream live-stream URL; mirrors stream.ts's buildDirectLiveUrl byte-for-byte so the two don't drift. */
export function buildLiveStreamUrl(
  creds: Creds,
  streamId: string | number,
  containerExt: string | null | undefined
): string {
  const ext = containerExt === "ts" ? ".ts" : ".m3u8"
  return (
    fmtBase(creds.host, creds.port) +
    "/live/" +
    encodeURIComponent(creds.user) +
    "/" +
    encodeURIComponent(creds.pass) +
    "/" +
    encodeURIComponent(streamId) +
    ext
  )
}

/**
 * Resolve a provider `stream_url` override exactly the way the legacy
 * movie detail page does (`movies/detail.ts`): an absolute URL is used
 * as-is; a relative path is joined to the provider base. Returns null
 * when there is no override, so the caller falls back to the built URL.
 */
export function resolveVodStreamUrlOverride(
  creds: Creds,
  streamUrl: string | null | undefined
): string | null {
  if (typeof streamUrl !== "string") return null
  const trimmed = streamUrl.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const relPath = trimmed.replace(/^\/+/, "")
  if (!relPath) return null
  return `${fmtBase(creds.host, creds.port).replace(/\/+$/, "")}/${relPath}`
}

export interface VodPlaySource {
  /** Final URL to feed the player: override, built, or probe-verified. */
  src: string
  /**
   * Container the byte probe verified when the provider supplied no
   * extension. Null when the extension was known or the probe found
   * nothing — the caller then keeps the built URL and the player's
   * error path still protects playback.
   */
  probedContainer: "mkv" | "mp4" | null
}

/**
 * Resolve the playable source for one VOD item (0.11.9): a provider
 * `stream_url` override wins; otherwise the canonical built URL. When
 * the provider supplied no container extension, the first bytes are
 * probed instead of trusting the blind `.mp4` default, and the URL's
 * extension is swapped to the verified container so every downstream
 * sniffer (container plan, tee proxy, MIME, error classification) sees
 * the real container. A failed probe keeps the built URL.
 */
export async function resolveVodPlaySrc(args: {
  creds: Creds
  kind: "movie" | "episode"
  id: string | number
  containerExt: string | null | undefined
  streamUrl: string | null | undefined
}): Promise<VodPlaySource> {
  const override = resolveVodStreamUrlOverride(args.creds, args.streamUrl)
  if (override) return { src: override, probedContainer: null }
  const built =
    args.kind === "movie"
      ? buildMovieStreamUrl(args.creds, args.id, args.containerExt)
      : buildSeriesStreamUrl(args.creds, args.id, args.containerExt)
  if (args.containerExt) return { src: built, probedContainer: null }
  const probed = await probeVodContainerAlternative(built).catch(() => null)
  if (!probed) return { src: built, probedContainer: null }
  const src =
    probed.container === "mkv"
      ? (swapUrlExtension(probed.url, "mkv") ?? probed.url)
      : probed.url
  return { src, probedContainer: probed.container }
}
