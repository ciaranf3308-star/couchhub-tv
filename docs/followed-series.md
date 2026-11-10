# Followed Series — NylahBox Studios (CouchHub TV)

Follow shows, get told when a new episode lands. Everything here is local:
subscriptions live in the app's IndexedDB, checks use provider metadata
only (never a stream), and the launcher learns about new episodes from one
small JSON file.

## What it does

- **Follow / Unfollow** — bell button on the series detail page. Following
  records the episodes available *right now* as the baseline. The back
  catalogue never alerts. Unfollowing removes the subscription and drops
  its unread notifications; read history is kept.
- **Background checks** — every 6 hours by default (3/6/12/24 h in
  Settings → Followed Series). A check also runs when the app opens, if
  the last check is stale. A manual **Check now** lives on `/followed`
  and in Settings.
- **New Episodes** — `/followed` (sidebar: Followed) shows one grouped
  notification per series per check (poster, series title, season/episode,
  episode title, detected date, watched status, **Watch Now**). Mark read,
  dismiss, or open the episode. Watching an episode (playback finishes,
  or manually marked watched) clears its unread notification.
- **M3U playlists** — follow is unavailable where no reliable series
  metadata exists: the Follow button is disabled with an explanation, and
  the management view reports the show as unsupported rather than
  guessing.

## False-positive guards

Detection compares normalised episode-key sets (`get_series_info`
flattened to season/episode/provider-id/title). By construction it does
not alert on:

- ordering changes, reordered seasons, duplicate rows, renames (same
  provider id, new title).

And it refuses to act on bad data:

- **Empty / incomplete response** — the baseline is kept, the show is
  marked `incomplete`, and the next check is backed off (15 min doubling,
  capped at 6 h).
- **Truncated snapshot** (fresh list < half the baseline) — same handling.
- **Bulk remap** — if most old episodes vanished *and* most fresh ones
  look "new" (both ratios > 50%), the provider almost certainly remapped
  ids. No notifications are sent, the old baseline is kept, and the show
  is flagged **needs re-baseline** in the management view. Re-baselining
  adopts the new ids silently.
- **Connectivity failures** — baseline kept, backoff applied.
- **Overlapping scans** — an in-process mutex plus a stored lock (15 min
  TTL) means two windows (or a manual + scheduled run) collapse into one.

A genuine new season is *not* a remap: nothing old disappeared, so it
alerts normally. No exact upload time is ever claimed — notifications say
"Newly detected in your library" with the detection date.

## Deep link (launcher contract)

The TV exe accepts:

```
"<exe>" --open-series <seriesId> [--episode <season>:<episode>]
```

Examples:

```
"%LOCALAPPDATA%\CouchHub TV\couchhub-tv.exe" --open-series 42
"%LOCALAPPDATA%\CouchHub TV\couchhub-tv.exe" --open-series 42 --episode 2:3
```

- `seriesId` is the opaque provider series id. `--episode` is optional;
  `season:episode` are 1-based numbers, not provider episode ids.
- With an episode, the app opens the series detail page, switches to
  that season, and autoplays the episode. Without one, it opens the
  series page.
- If the app is already running, the launch is forwarded to the running
  instance (single-instance plugin) — no second window. A plain second
  launch just brings the existing window forward.
- Invalid values (empty id, `0:3`, `banana`) are dropped, never
  navigated to.

## Background checks while the app is closed

Preferred mechanism: a CLI flag on the installed exe.

```
"<exe>" --check-followed
```

It starts hidden (no tray icon, no window), runs one metadata-only
check across every followed series, publishes `notifications.json`, and
exits. A 10-minute watchdog exits it even if a provider hangs. If the
app is already running, the scheduled launch hands the check to the
running instance instead.

### Scheduled Task

- **Name:** `NylahBox Studios Followed Series Check`
- **Trigger:** hourly, every N hours (N = the Settings interval),
  starting now.
- **Action:** `"<current exe path>" --check-followed`
- **Surviving updates:** on every app start (when scheduled checks are
  enabled) the app re-registers the task if it is missing, points at a
  stale exe path (an update moved it), or runs on the wrong interval.
  Turning scheduled checks off in Settings removes the task; in-app
  checks still work.
- **Uninstall cleanup — honest version:** the Tauri NSIS uninstaller
  does *not* remove the task. After uninstall, the task remains and its
  action points at an exe that no longer exists, so it fails silently
  each run. Remove it before uninstalling (turn scheduled checks off in
  Settings), or delete it afterwards in Task Scheduler, or from an
  elevated prompt:

  ```
  schtasks /Delete /TN "NylahBox Studios Followed Series Check" /F
  ```

  Pre-rename installs may also carry a `Nylah Studios Followed Series Check`
  task; the app best-effort deletes that legacy name whenever scheduled
  checks are enabled, repaired, or turned off, so an install never runs two.

## Launcher contract — notifications.json

The TV app owns and atomically updates (temp file + rename, folder
created if missing):

```
%LOCALAPPDATA%\RedSilk\integration\notifications.json
```

Note: this is `%LOCALAPPDATA%\RedSilk\...` explicitly — **not** the TV
app's own app-data directory. The file is rewritten whenever the unread
set changes (after any check, after mark-read/dismiss).

```json
{
  "schemaVersion": 1,
  "lastCheck": "<ISO-8601 UTC>",
  "unreadCount": 3,
  "notifications": [
    {
      "seriesId": "<opaque id>",
      "seriesTitle": "<title>",
      "season": 2,
      "episode": 3,
      "episodeTitle": "<title or empty>",
      "detectedAt": "<ISO-8601 UTC>",
      "posterUrl": "<optional, local/cache only>"
    }
  ]
}
```

- One entry per episode, newest first, bounded to the latest 10.
- `unreadCount` is the number of entries in the list.
- **No passwords, no streaming URLs, no provider URLs.** `posterUrl`
  is only ever included when it is a local/cache URL (`file://`,
  `asset://`, `app://`, absolute path, `data:image/`); provider poster
  URLs are omitted.
- The Rust publisher validates `schemaVersion: 1` and the presence of
  the `notifications` array before writing.

## Discover seam

`src/scripts/lib/followed.ts` exports:

```ts
export const followedProvider = {
  getNewEpisodes(): FollowedEpisode[] { ... }
}
```

where

```ts
interface FollowedEpisode {
  seriesId: string
  seriesTitle: string
  season: number
  episode: number
  episodeTitle?: string
  detectedAt: string
  posterUrl?: string
  watched: boolean
}
```

Callers should `await ensureFollowedLoaded()` once after boot; the
getter itself is synchronous by contract and returns the last-loaded
unread snapshot. The Discover module is intentionally **not** imported
here — the coordinator wires the two together.

## Files

- `src/scripts/lib/followed.ts` — engine, store, check runner,
  notifications, settings, seam, notifications.json (de)serialisation.
- `src/scripts/lib/followed-startup.ts` — boot wiring (deep links,
  stale check, schedule repair, headless mode). Mounted in Layout.
- `src/pages/followed.astro` + `src/scripts/followed-page.ts` —
  management view + New Episodes.
- `src/scripts/settings/followed-card.ts` — Settings section wiring.
- `src-tauri/src/followed.rs` — CLI parsing, single-instance
  forwarding, notifications.json publishing, Scheduled Task commands.
- `src-tauri/src/followed_core.rs` — pure Rust logic (CLI parsing,
  notifications.json validation, schtasks string handling) with no
  Tauri dependency, so its 14 unit tests run without the desktop
  system libraries.
- `tests/followed.test.ts` — 46 vitest tests (synthetic fixtures only;
  no live provider needed).

## Unverified (read before trusting this on hardware)

- No real provider was polled during development; detection ran only
  against synthetic `get_series_info` fixtures.
- The Scheduled Task registration/repair and the headless
  `--check-followed` run have never executed on Windows — `schtasks`
  behaviour (prompts, privileges, `/ST` handling) is unproven on the
  real PC.
- The deep-link forward to a running instance depends on the
  single-instance plugin, which is new to this codebase; the handoff has
  not been exercised on Windows.
- The notifications.json file has not been read by the launcher yet
  (worker W4 owns that side).
